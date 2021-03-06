// upload
'use strict';
module.exports = function (server) {

  var formidable = require('formidable');
  var fs = require('fs');
  var Path = require('path');

  var mkdirp = require('mkdirp');

  //var imageMagick = require('imagemagick');

  //var memoryStream = require('memorystream');
  //var request = require('request');

  var FileInfo = require('./fileinfo');

  var UploadHandler = require('./handler');
  var zipFile = require('./zipfile');

  var Collection = require('./collection');
  var Resource = require('./resource');
  var Asset = require('./asset');

  var Mime = require('mime');

  var extend = require('./extend');
  var rmdirSync = require('./rmdir');


  Mime.define({
    'model/collada+xml': ['dae']
  });
  Mime.define({
    'text/x-glsl': ['glsl']
  });

  var utf8encode = function (str) {
    return unescape(encodeURIComponent(str));
  };

  // here's a dummy database
  var tmpdb={};
  tmpdb.assets={};
  tmpdb.name = 'tmp';
  tmpdb.noversioning = true; // no undo/versioning at all on database tmp

  tmpdb.root = null; // where we store each user root collection

  tmpdb.saveAsset = function(asset,cb){
    // update root if this asset is the root folder
    if (asset.name === '/') tmpdb.root = asset;
    tmpdb.assets[asset.uuid] = asset;
    cb(undefined,asset);
  }
  tmpdb.loadAsset = function(id,cb){
    // need to clone this guy !!
    var res = tmpdb.assets[id];
    if (!res) return cb('database[tmp] cannot find asset id='+id);

    if (res.mimetype === Collection.mimetype)
        res = extend(new Collection(),res);
    else if (res.mimetype === Asset.mimetype)
        res = extend(new Asset(),res);
    else
        res = extend(new Resource(),res);

    res.database=tmpdb;
    cb(undefined, res)
  }

  // we don't have real locks on tmpdb
  tmpdb.lockAsset = function(asset,cb){
    tmpdb.loadAsset(asset.uuid,cb);
  }

  tmpdb.unlockAsset = function(asset,cb){
    cb(undefined,asset);
  }

  tmpdb.getRoot = function(cb){
    cb(undefined, tmpdb.root);
  }
  
  var createTMP = function(req,res,next){
    // create tmp folder for user
    Collection.create(tmpdb,Path.join('/',req.session.sid), req.session.sid, function(err,collection){
      if (err){
        console.log('Could NOT create TMP folder for user='+req.session.sid)

        next(err);
      } 
      else {
        req.session.tmpdir=collection.uuid;
        server.sessionManager.save(req.session.sid, req.session, next)

        var path=Path.resolve(FileInfo.options.uploadDir,req.session.tmpdir);
        mkdirp.sync(path);

        console.log('Created TMP['+req.session.tmpdir+'] for session='+req.session.sid)

      }
    })
  };

  // make this function available to the session manager so it can delete the TMP folder
  //   when it decides to delete the session
  server.sessionManager.delTMP = function(uuid,cb) {
    Collection.getroot(tmpdb,function(err,root){
      if (err) return cb(err);

       root.rmdir(uuid,function(err,res){
         if (err) return cb(err);
         // now for some violence
         // we know this folder and content is not referenced by anybody, 
         var path=Path.resolve(FileInfo.options.uploadDir,uuid);
         rmdirSync(path);

       console.log('Deleted TMP['+uuid+'] for session='+uuid)
       })
      
    })
  };

  // make sure we have a tmp folder for this user
  server.use(function(req,res,next){
    if (!req.session || !req.session.sid)
    return next(new Error('cannot find sid in upload::createTMP'))
    if (!req.session.tmpdir) 
      createTMP (req,res,next);
    else
      next();
  })


  // upload one or more files
  UploadHandler.prototype.post = function (collectionpath, assetpath) {
    var handler = this;
    var form = new formidable.IncomingForm();
    var tmpFiles = [];
    var files = [];
    //var map = {}
    var counter = 1;

  
    var finish = function (err, asset) {
      if (err) {
        console.log('ERROR IN UPLOAD FINISH');
        counter = -1;
        handler.handleError(err);
        return;
      }
      counter -= 1;
      if (counter === 0) {
      
        var results = [];
        counter = files.length;
        if (!counter)
          return handler.handleError({message:'post did not send any files', statusCode:400})
        files.forEach(function (fileInfo) {
          var res = fileInfo.asset.getSync();

          res.assetpath = fileInfo.assetpath;
          res.collectionpath = fileInfo.collectionpath;
          // remove sid from collectionpath for database tmp
          if (res.database === 'tmp') {
            if (res.collectionpath.contains('/'))
              res.collectionpath = res.collectionpath.stringAfter('/')
            else
              res.collectionpath = "";
          } else 
            res 
          results.push(res)
          counter--;
          if (counter == 0)
            handler.handleResult(results);

        });
      
      }
    };

    //form.uploadDir = FileInfo.options.tmpDir;
    form.on('fileBegin', function (name, file) {

      // in case there is an abort, we can delete tmpFiles
      tmpFiles.push(file.path);
      //var fileInfo = new FileInfo(file, collectionpath, assetpath);
      //fileInfo.safeName();
      //map[file.path] = fileInfo;
      //files.push(fileInfo); -> this will happen later

    }).on('field', function (name, value) {
       if (name === 'url') {
        // downloading file and uncompressing if needed
        // counter++; -> getting all files at once
        //                                                      no jar
        counter++; // one more result to POST
        zipFile.unzipUploadUrl(handler, collectionpath, assetpath, value, null, function(error,result) {
          if (error)
            handler.handleError(error);
          else {
            // turn {asset} into fileInfos
            files = files.concat(result);
            
            finish(undefined);
          }
        });
      } else if (name === 'collection') {
        // create a collection at path 
        counter++; // one more result to POST
        var newcollection = value;

        Collection.create(handler.db, Path.join(collectionpath,assetpath,value), handler.sid, function(err,col){
          if (err) return finish(err);
          var fileInfo = new FileInfo(undefined, collectionpath, assetpath);
          fileInfo.asset = col;
          files.push(fileInfo);
          finish(undefined,col);
        });
      }
    }).on('file', function (name, file) {

      if (file.size ===0) {
        // form did not send a valid file
        return finish({message:'form sent empty file',statusCode:400});
      }

      counter++; // so that 'end' does not finish
      //                                                                               no jar
      zipFile.unzipUploadFile(handler, collectionpath, assetpath, file.name, file.path, null, function(error,result) {
        if (error)
          finish(error);
        else {
          files = files.concat(result);
          
          finish(undefined);
        }
      });

    }).on('aborted', function () {
      tmpFiles.forEach(function (file) {
        fs.unlinkSync(file);
      });
    }).on('error', function (e) {
      finish({message:'Could not parse form', statusCode:400});
    }).on('progress', function (bytesReceived, bytesExpected) {
      if (bytesReceived > FileInfo.options.maxPostSize) {
        handler.req.connection.destroy();
      }
    }).on('end', finish);
    form.parse(handler.req);
  };

  // delete a file
  UploadHandler.prototype.destroy = function () {
    var handler = this;

    if (handler.req.url.slice(0, FileInfo.options.uploadUrl.length) === FileInfo.options.uploadUrl) {
      var fileName = Path.basename(decodeURIComponent(handler.req.url));
      if (fileName[0] !== '.') {
        fs.unlink(Path.join(FileInfo.options.uploadDir, fileName), function (ex) {
          Object.keys(FileInfo.options.imageVersions).forEach(function (version) {
            fs.unlink(Path.join(FileInfo.options.uploadDir, version, fileName));
          });
          handler.handleResult({
            success: !ex
          });
          return;
        });
        return;
      }
    }
    handler.handleResult({
      success: false
    });
  };


  UploadHandler.prototype.get = function(params,uuid){

    var handler = this;

    if (!params && !uuid) {
      Collection.find(handler.db, Path.join('/', handler.sid), function (err, result) {
        if (err) return handler.handleError(err);
        else {
          var result = result.collection.getSync();
           
          // replace sid with '/' in col path, so this is hidden from client
          if (handler.db === tmpdb)
            result.name = '/';
          return handler.handleResult(result);
        }
      })

    } else if (uuid) {
      console.log('handler.get uuid=' + uuid);
      Resource.load(handler.db, uuid, function (err, resource) {
        if (err) handler.handleError(err);
        else {
          var result = resource.getSync();
            
          if (handler.db === tmpdb && result.name === handler.sid)
            result.name = '/';

          return handler.handleResult(result);

        }
      })
    } else /* this is a path */ {

      if (handler.db === tmpdb)
        params = Path.join('/', handler.sid, params);

      Collection.find(handler.db, params, function (err, res) {
        if (err) return handler.handleError(err);
        else {
          // res = {path collection}
          // this is a collection that we queried for

          // remove path from query
          console.log('res upload returned match =' + res.path + ' asset =' + res.assetpath);

          if (!res.assetpath) { // we found a collection
            var result = res.collection.getSync();
            return handler.handleResult(result);

          } else {

            // let see if there is an asset there
            console.log(' ... looking for asset at ' + res.path + ' name=' + res.assetpath);

            res.collection.getResource(res.assetpath, function (err, resource) {
              if (err) return handler.handleError(err);
              if (!resource) return handler.handleError('get /tmp/ cannot find resource at =' + res.assetpath);
              
              var result = resource.getSync();
              return handler.handleResult(result);
             
            })
          }
        }
      })
    }
  };

  UploadHandler.prototype.getData = function(params,uuid){

    var handler = this;

    if (!params && !uuid) {
      handler.handleError({message:'get data on collection is not supported',statusCode:400})
    } else if (uuid) {
      console.log('handler.getData uuid=' + uuid);
      Resource.load(handler.db, uuid, function (err, resource) {
        if (err) handler.handleError(err);
        else {
          if (resource instanceof Collection)
            return handler.handleError({message:'get data on collection is not supported',statusCode:400})
          if (resource instanceof Asset){
            // lets get to the resource itself
            resource = resource.getResourceSync();
          }

          if (handler.db === tmpdb) {
            var filename=Path.resolve(FileInfo.options.uploadDir, handler.req.session.tmpdir, resource.uuid);

            handler.sendFile(filename,resource.type,resource.name);
          } else {
            //handler.redirect(handler.db.getUrl(resource));
            handler.db.getData(resource, function(err,filename){
              if (err)
                handler.handleError(err);
              else
                handler.sendFile(filename, resource.type, resource.name);
            })
          }
          
        }
      })
    } else /* this is a path */ {

      if (handler.db === tmpdb)
        params = Path.join('/', handler.sid, params);

      Collection.find(handler.db, params, function (err, res) {
        if (err) return handler.handleError(err);
        else {
          // res = {path collection}
          // this is a collection that we queried for

          // remove path from query
          console.log('res upload returned match =' + res.path + ' asset =' + res.assetpath);

          if (!res.assetpath) { // we found a collection
            var result = res.collection.getSync();
            return handler.handleResult(result);
          } else {

            // let see if there is an asset there
            console.log(' ... looking for asset at ' + res.path + ' name=' + res.assetpath);

            res.collection.getResource(res.assetpath, function (err, resource) {
              if (err) return handler.handleError(err);
              if (!resource) return handler.handleError('get /tmp/ cannot find resource at =' + res.assetpath);
              
              if (handler.db === tmpdb) {
                var filename=Path.resolve(FileInfo.options.uploadDir, handler.req.session.tmpdir, resource.uuid);

                handler.sendFile(filename,resource.type,resource.name);
              } else {
                //handler.redirect(handler.db.getUrl(resource));
                handler.db.getData(resource, function(err,filename){
                  if (err)
                    handler.handleError(err);
                  else
                    handler.sendFile(filename, resource.type, resource.name);
                })
              }
              
            })
          }
        }
      })
    }
  };

  // routes

  // rest3d post upload API
  server.post(/^\/rest3d\/tmp.*/, function (req, res, next) {

    var handler = new UploadHandler(req, res, next);
    handler.allowOrigin();
    handler.db = tmpdb;

    var params = req.url.stringAfter("/tmp");


    Collection.find(handler.db, Path.join('/', handler.sid, params), function (err, result) {

      console.log('res POST returned match =' + result.path + ' asset =' + result.assetpath);

      handler.post(result.path, result.assetpath);

    })

  });


  server.get(/^\/rest3d\/info\/tmp.*/, function (req, res, next) {
    var handler = new UploadHandler(req, res, next);
    handler.allowOrigin();
    handler.db = tmpdb;

    var params = req.url.stringAfter('/tmp');
    if (params.contains('?'))
      params = params.stringBefore('?');
    while (params.slice(-1) === '/') params = params.slice(0, -1);

    var uuid = req.query.uuid;

    console.log('in GET tmp/ for asset=' + params + ' path= '+uuid)

    handler.get(params, req.query.uuid);
  });

  server.get(/^\/rest3d\/data\/tmp.*/, function (req, res, next) {
    var handler = new UploadHandler(req, res, next);
    handler.allowOrigin();
    handler.db = tmpdb;

    var params = req.url.stringAfter('/tmp');
    if (params.contains('?'))
      params = params.stringBefore('?');
    while (params.slice(-1) === '/') params = params.slice(0, -1);

    var uuid = req.query.uuid;

    console.log('in GET data tmp/ for asset=' + params + ' path= '+uuid)

    handler.getData(params, req.query.uuid);
  });

  // rest3d post upload API
  server.post(/^\/rest3d\/convert\/tmp.*/, function (req, res, next) {

    var handler = new UploadHandler(req, res, next);
    handler.allowOrigin();
    handler.db = tmpdb;

    var params = req.url.stringAfter('/tmp');

    Collection.find(handler.db, Path.join('/', handler.sid, params), function (err, result) {

      console.log('res POST returned match =' + result.path + ' asset =' + result.assetpath);

      handler.convert(result.path, result.assetpath);

    })

  });

};