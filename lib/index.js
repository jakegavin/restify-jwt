var jwt = require('jsonwebtoken');
var unless = require('express-unless');
var restify = require('restify');
var async = require('async');
var errors = require('restify-errors');

var DEFAULT_REVOKED_FUNCTION = function(_, __, cb) { return cb(null, false); };

var getClass = {}.toString;
function isFunction(object) {
  return object && getClass.call(object) == '[object Function]';
}

function wrapStaticSecretInCallback(secret){
  return function(_, __, cb){
    return cb(null, secret);
  };
}

module.exports = function(options) {
  if (!options || !options.secret) throw new Error('secret should be set');

  var secretCallback = options.secret;

  if (!isFunction(secretCallback)){
    secretCallback = wrapStaticSecretInCallback(secretCallback);
  }

  var isRevokedCallback = options.isRevoked || DEFAULT_REVOKED_FUNCTION;

  var _requestProperty = options.userProperty || options.requestProperty || 'user';
  var credentialsRequired = typeof options.credentialsRequired === 'undefined' ? true : options.credentialsRequired;

  var middleware = function(req, res, next) {
    var token;

    if (req.method === 'OPTIONS' && req.headers.hasOwnProperty('access-control-request-headers')) {
      var hasAuthInAccessControl = !!~req.headers['access-control-request-headers']
                                    .split(',').map(function (header) {
                                      return header.trim();
                                    }).indexOf('authorization');

      if (hasAuthInAccessControl) {
        return next();
      }
    }

    if (options.getToken && typeof options.getToken === 'function') {
      try {
        token = options.getToken(req);
      } catch (e) {
        return next(e);
      }
    } else if (req.headers && req.headers.authorization) {
      var parts = req.headers.authorization.split(' ');
      if (parts.length == 2) {
        var scheme = parts[0];
        var credentials = parts[1];

        if (/^Bearer$/i.test(scheme)) {
          token = credentials;
        } else {
          return next(new errors.InvalidCredentialsError('Format is Authorization: Bearer [token]'));
        }
      } else {
        return next(new errors.InvalidCredentialsError('Format is Authorization: Bearer [token]'));
      }
    }

    if (!token) {
      if (credentialsRequired) {
        return next(new errors.InvalidCredentialsError('No authorization token was found'));
      } else {
        return next();
      }
    }

    var dtoken = jwt.decode(token, { complete: true }) || {};

    async.parallel([
      function(callback){
        var arity = secretCallback.length;
        if (arity == 4) {
          secretCallback(req, dtoken.header, dtoken.payload, callback);
        } else { // arity == 3
          secretCallback(req, dtoken.payload, callback);
        }
      },
      function(callback){
        isRevokedCallback(req, dtoken.payload, callback);
      }
    ], function(err, results){
      if (err) { return next(err); }
      var revoked = results[1];
      if (revoked){
        return next(new errors.UnauthorizedError('The token has been revoked.'));
      }

      var secret = results[0];

      jwt.verify(token, secret, options, function(err, decoded) {
        if (err && credentialsRequired) return next(new errors.InvalidCredentialsError(err));

        req[_requestProperty] = decoded;
        next();
      });
    });
  };

  middleware.unless = unless;

  return middleware;
};
