'use strict';

var PrettyStream = require('bunyan-prettystream');
var async = require('async');
var bunyan = require('bunyan');
var crypto = require('crypto');
var fs = require('fs-extra');
var glob = require('glob');
var parseXmlString = require('xml2js').parseString;
var path = require('path');
var traverse = require('traverse');
var xformToJson = require('xform-to-json');
var _ = require('lodash');

var prettyStream = new PrettyStream({
  mode: 'short'
});

prettyStream.pipe(process.stdout);

var logger = bunyan.createLogger({
  name: 'transfer',
  streams: [{
    level: 'debug',
    stream: process.stdout.isTTY ? prettyStream : process.stdout,
    type: process.stdout.isTTY ? 'raw' : 'stream'
  }]
});

var MEDIA_EXTENSIONS = [
  'gif',
  'jpg',
  'jpeg',
  'png',
  'bmp',
  'm4a',
  'mp3',
  'wav',
  'mpeg',
  'mp4',
  'avi',
  'zip',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'txt'
];

var RE_MEDIA_FILE = new RegExp('.+\\.(' + MEDIA_EXTENSIONS.join('|') +
  ')$', 'i');

// hash a given string or buffer
function md5(data) {
  var md5sum = crypto.createHash('md5');

  md5sum.update(data);

  return md5sum.digest('hex');
}

// find any ODK XML forms starting at the given file system root
function findForms(root, cb) {
  // XXX: *.xml is an assumption
  var xmlGlob = path.join(root, '**', '*.xml');

  glob(xmlGlob, function (globErr, files) {
    if (globErr) {
      logger.error({err: globErr}, 'error globbing "%s"', xmlGlob);

      return cb(null, []);
    }

    async.map(files, function (file, cbMap) {
      var data = fs.readFileSync(file);

      parseXmlString(data, function (parseErr, jsonData) {
        if (parseErr) {
          logger.error({err: parseErr}, 'failed to parse file "%s"', file);

          return cbMap();
        }

        var isOdkForm = false;

        _.forOwn(jsonData, function (property) {
          // TODO: Talk to Gregor and change this check
          var containsInstanceId = _.any(property.meta, function (meta) {
            return meta.instanceID && meta.instanceName;
          });

          if (containsInstanceId) {
            isOdkForm = true;
          }
        });

        if (!isOdkForm) {
          return cbMap();
        }

        cbMap(null, file);
      });
    }, function (ignoredError, fileData) {
      cb(null, _.compact(fileData));
    });
  });
}

// traverse every property of an xform and grab filenames that match those in
// the list of extensions
function filesNamesFromXform(xform) {
  var fileNames = [];

  traverse(xform).forEach(function (value) {
    var match = RE_MEDIA_FILE.exec(value);

    if (match) {
      fileNames.push(match[0]);
    }
  });

  return fileNames;
}

// find media files by globbing a root with a list of extensions
function findMediaFiles(root, cb) {
  var mediaGlob = '*.{' + MEDIA_EXTENSIONS.join(',') + '}';
  var mediaPath = path.join(root, '**', mediaGlob);

  glob(mediaPath, function (globErr, files) {
    if (globErr) {
      logger.error({err: globErr}, 'error globbing "%s"', mediaPath);

      return cb(null, []);
    }

    cb(null, files);
  });
}

// convert an XML form to JSON
function formsToJson(forms, cb) {
  async.map(forms, function (form, cbMap) {
    fs.readFile(form, 'utf8', function (err, contents) {
      if (err) {
        logger.error({err: err}, 'error reading form "%s"', form);

        return cbMap();
      }

      xformToJson(contents, null, function (xformErr, jsonForm) {
        if (xformErr) {
          logger.error('error converting xform to JSON', {err: xformErr});

          return cbMap();
        }

        jsonForm.meta.transfer = {
          originalPath: form
        };

        cbMap(null, jsonForm);
      });
    });
  }, function (ignoredError, result) {
    cb(result);
  });
}

// is the path of file a adjacent to directory b?
function fileInDirectory(a, b) {
  return path.dirname(a).toLowerCase() === b.toLowerCase();
}

// case-insensitive endsWith
function lowerCaseEndsWith(a, b) {
  return _.endsWith(a.toLowerCase(), b.toLowerCase());
}

// resolve a path relative to the current working directory
// function resolveToCwd(file) {
//   return path.resolve(process.cwd(), file);
// }

// add an md5 hash for each media file in the form
function addHashesToMedia(bundles, cb) {
  async.map(bundles, function (bundle, cbMapBundles) {
    async.map(bundle.media, function (media, cbMapMedia) {
      fs.readFile(media.path, function (err, imageData) {
        if (!err) {
          media.md5 = md5(imageData);
        }

        cbMapMedia(null, media);
      });
    }, function (ignoredError, media) {
      bundle.media = media;

      cbMapBundles(null, bundle);
    });
  }, cb);
}

// fs.copy with our options defaulted
function copy(a, b, cb) {
  fs.copy(a, b, {clobber: false}, cb);
}

// copy that takes a destination directory instead of a full path
function copyToDirectory(file, directory, cb) {
  copy(file, path.join(directory, path.basename(file)), cb);
}

// given a media file, return its new hashed filename
function hashName(mediaFile) {
  return mediaFile.md5 + path.extname(mediaFile.name);
}

// create the destination directory
function mkdirStep(destination) {
  return function (cb) {
    fs.mkdirp(destination, function (err) {
      if (err) {
        logger.error('unable to create destination directory', {err: err});

        return cb(err);
      }

      cb();
    });
  };
}

// copy a file
function copyStep(source, destination) {
  return function (cb) {
    logger.info('copying "%s" to "%s"', source, destination);

    copyToDirectory(source, destination, function (err) {
      if (err) {
        logger.error('unable to copy "%s"', source, {err: err});
      }

      cb();
    });
  };
}

// write the form JSON
function writeJsonStep(object, destination) {
  return function (cb) {
    var text = JSON.stringify(object, null, 2);

    fs.writeFile(destination, text, function (err) {
      if (err) {
        logger.error('unable to write "%s"', destination, {err: err});
      }

      cb();
    });
  };
}

// copy the form's media files
function copyMediaStep(media, destination) {
  return function (cb) {
    async.each(media, function (mediaFile, cbEachMedia) {
      logger.info('copying "%s" to "%s"', mediaFile.path, destination);

      var mediaDestination = path.join(destination, mediaFile.path);

      if (mediaFile.md5) {
        mediaDestination = path.join(destination, hashName(mediaFile));
      }

      copy(mediaFile.path, mediaDestination, function (err) {
        if (err) {
          logger.error('unable to copy "%s"', mediaFile.path, {err: err});
        }

        cbEachMedia();
      });
    }, cb);
  };
}

// copy a single bundle to its destination directory
function copyBundle(bundle, destination, cb) {
  var originalPath = bundle.form.meta.transfer.originalPath;

  var formName = path.basename(originalPath, path.extname(originalPath));
  var formDestination = path.join(destination, formName);

  traverse(bundle.form).forEach(function (value) {
    var mediaFile = _.find(bundle.media, function (media) {
      return media.name === value;
    });

    if (mediaFile && mediaFile.md5) {
      this.update(hashName(mediaFile));
    }
  });

  async.series([
    mkdirStep(formDestination),
    writeJsonStep(bundle.form, path.join(formDestination, formName + '.json')),
    copyStep(originalPath, formDestination),
    copyMediaStep(bundle.media, formDestination)
  ], cb);
}

// copy the given bundles to their destination directory
function copyBundles(bundles, destination, cb) {
  async.eachSeries(bundles, _.partialRight(copyBundle, destination, _), cb);
}

var roots = [path.resolve('..', 'ODK-2014')];

function resolvePaths(fileName, media, formPathBase) {
  var endsWith = _.partialRight(lowerCaseEndsWith, fileName, _, _);
  var filePaths = media.filter(endsWith);

  var fileInFormDirectory = _.partialRight(fileInDirectory, formPathBase, _, _);

  var inFormDirectory = _.filter(filePaths, fileInFormDirectory);
  var notInFormDirectory = _.reject(filePaths, fileInFormDirectory);

  var filePath = inFormDirectory[0] || notInFormDirectory[0];

  if (filePath && _.isEmpty(inFormDirectory)) {
    logger.warn('form file "%s" was found outside of the ' +
      'directory where its form lives', fileName, {
        filePathBase: filePath,
        formPathBase: formPathBase
      });
  }

  if (!filePath) {
    logger.warn('form file "%s" not found', fileName);

    return null;
  }

  return {
    name: fileName,
    path: filePath
  };
}

function bundleMedia(form, media) {
  var fileNames = filesNamesFromXform(form);
  var formPathBase = path.dirname(form.meta.transfer.originalPath);

  var resolvedPaths = _(fileNames)
    .map(_.partialRight(resolvePaths, media, formPathBase, _, _))
    .compact()
    .value();

  return {
    form: form,
    media: resolvedPaths
  };
}

// TODO: discover drive roots
async.eachSeries(roots, function (root) {
  logger.info('root directory: %s', root);

  async.parallel({
    media: async.apply(findMediaFiles, root),
    forms: async.apply(findForms, root)
  }, function (ignoredError, result) {
    logger.info('found media', result.media);
    logger.info('found forms', result.forms);

    formsToJson(result.forms, function (forms) {
      var bundles = forms.map(_.partialRight(bundleMedia, result.media, _, _));

      addHashesToMedia(bundles, function (ignoredErr, hashedBundles) {
        hashedBundles.forEach(function (bundle) {
          logger.info('bundle.media', bundle.media);
        });

        // TODO: generate destination list automatically
        var destination = path.resolve(process.cwd(), '../destination-a');

        copyBundles(hashedBundles, destination, function () {
          logger.info('done');
        });
      });
    });
  });
});
