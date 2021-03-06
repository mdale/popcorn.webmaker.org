// Newrelic *must* be the first module loaded. Do not move this require module!
if ( process.env.NEW_RELIC_HOME ) {
  require( 'newrelic' );
}

var express = require('express'),
    fs = require('fs'),
    path = require('path'),
    jade = require('jade'),
    app = express(),
    lessMiddleware = require('less-middleware'),
    requirejsMiddleware = require( 'requirejs-middleware' ),
    config = require( './lib/config' ),
    Project,
    filter,
    sanitizer = require( './lib/sanitizer' ),
    FileStore = require('./lib/file-store.js'),
    metrics,
    utils,
    middleware = require( './lib/middleware' ),
    stores = {},
    APP_HOSTNAME = config.hostname,
    WWW_ROOT = path.resolve( __dirname, config.dirs.wwwRoot ),
    VALID_TEMPLATES = config.templates,
    port = config.PORT;

var templateConfigs = {};

function readTemplateConfig( templateName, templatedPath ) {
  var configPath = templatedPath.replace( '{{templateBase}}', config.dirs.templates + '/' );
  // Resolve paths relative to server.js, not the cwd
  configPath = path.resolve( __dirname, configPath );

  fs.readFile( configPath, 'utf8', function( err, conf ) {
    var configPathBase = configPath.substring( 0, configPath.lastIndexOf( '/' ) );
    conf = JSON.parse( conf );
    conf.template = configPathBase + '/' + conf.template;
    templateConfigs[ templateName ] = conf;
  });
}

// parse configs ahead of any action that has to happen with them
for ( var templateName in VALID_TEMPLATES ) {
  if ( VALID_TEMPLATES.hasOwnProperty( templateName ) ) {
    readTemplateConfig( templateName, VALID_TEMPLATES[ templateName ] );
  }
}

function setupStore( storeConfig ) {
  var store = FileStore.create( storeConfig.type, storeConfig.options );
  if ( store.requiresFileSystem ) {
    app.use( express.static( store.root, JSON.parse( JSON.stringify( config.staticMiddleware ) ) ) );
  }
  return store;
}

if ( config.USE_WEBFAKER ) {
  var webfaker = require( "webfaker" );

  webfaker.start({
    port: port + 1,
    username: config.MAKE_USERNAME,
    password: config.MAKE_PASSWORD,
    isAdminCheck: false
  }, function() {
    console.log( "Started Webfaker services on http://localhost ports: FakeAPI=%s, Fogin=%s, Fubble=%s",
                 port + 1, port + 2, port + 3 );

    process.on( "exit", function() {
      webfaker.stop();
    });
  });
}

app.configure( function() {
  var tmpDir = path.normalize( require( "os" ).tmpDir() + "/mozilla.butter/" );

  app.set( "views", __dirname + "/views" );

  app.use( express.logger( config.logger ) )
    .use( express.compress() )
    .use( lessMiddleware({
      once: config.OPTIMIZE_CSS,
      dest: tmpDir,
      src: WWW_ROOT,
      compress: config.OPTIMIZE_CSS,
      yuicompress: config.OPTIMIZE_CSS,
      optimization: config.OPTIMIZE_CSS ? 0 : 2
    }))
    .use( requirejsMiddleware({
      src: WWW_ROOT,
      dest: tmpDir,
      once: config.OPTIMIZE_JS,
      modules: {
        "/src/butter.js": {
          include: [ "butter" ],
          mainConfigFile: WWW_ROOT + "/src/popcorn.js",
        },
        "/src/embed.js": {
          include: [ "embed" ],
          mainConfigFile: WWW_ROOT + "/src/popcorn.js",
        },
        "/src/webmakernav.js": {
          include: [ "webmakernav" ],
          mainConfigFile: WWW_ROOT + "/src/webmakernav.js",
        }
      },
      defaults: {
        baseUrl: WWW_ROOT + "/src/",
        findNestedDependencies: true,
        optimize: "none",
        preserveLicenseComments: false,
        wrap: {
          startFile: __dirname + "/tools/wrap.start",
          endFile: __dirname + "/tools/wrap.end"
        }
      }
    }))
    .use( express.static( tmpDir, JSON.parse( JSON.stringify( config.staticMiddleware ) ) ) )
    .use( express.static( WWW_ROOT, JSON.parse( JSON.stringify( config.staticMiddleware ) ) ) );

  // File Store types and options come from JSON config file.
  stores.publish = setupStore( config.publishStore );
  stores.crash = setupStore( config.crashStore );
  stores.feedback = setupStore( config.feedbackStore );
  stores.images = setupStore( config.imageStore );

  app.use( express.bodyParser() )
    .use( express.cookieParser() )
    .use( express.cookieSession( config.session ) )
    .use( express.csrf() )
    /* Show Zeus who's boss
     * This only affects requests under /api and /persona, not static files
     * because the static file writes the response header before we hit this middleware
     */
    .use( function( req, res, next ) {
      res.header( 'Cache-Control', 'no-store' );
      return next();
    })
    .use( app.router )
    .use( function( err, req, res, next) {
      if ( !err.status ) {
        err.status = 500;
      }

      res.status( err.status );
      res.render( 'error.jade', { message: err.message, status: err.status });
    })
    .use( function( req, res, next ) {
      res.status( 404 );
      res.render( 'error.jade', { message: "This page doesn't exist", status: 404 });
    });

  // Metrics [optional]: allow data to be collected during runtime.
  // See JSON config file for details on metrics setup.
  metrics = require('./lib/metrics.js').create( config.metrics );

  utils = require( './lib/utils' )({
    EMBED_HOSTNAME: config.dirs.embedHostname ? config.dirs.embedHostname : APP_HOSTNAME,
    EMBED_SUFFIX: '_'
  }, stores );

  Project = require( './lib/project' )( config.database, {
    apiURL: config.MAKE_ENDPOINT,
    auth: config.MAKE_USERNAME + ":" + config.MAKE_PASSWORD
  }, utils );
  filter = require( './lib/filter' )( Project.isDBOnline );
});

require( 'express-persona' )( app, {
  audience: config.AUDIENCE
});

var routes = require('./routes');
routes( app, Project, filter, sanitizer, stores, utils, metrics );

function writeEmbedShell( embedPath, url, data, callback ) {
  if( !writeEmbedShell.templateFn ) {
    writeEmbedShell.templateFn = jade.compile( fs.readFileSync( path.resolve( __dirname, 'views/embed-shell.jade' ), 'utf8' ),
                                          { filename: 'embed-shell.jade', pretty: true } );
  }
  var sanitized = sanitizer.compressHTMLEntities( writeEmbedShell.templateFn( data ) );
  stores.publish.write( embedPath, sanitized, callback );
}

function writeEmbed( embedPath, url, data, callback ) {
  if( !writeEmbed.templateFn ) {
    writeEmbed.templateFn = jade.compile( fs.readFileSync( path.resolve( __dirname, 'views/embed.jade' ), 'utf8' ),
                                          { filename: 'embed.jade', pretty: true } );
  }
  var sanitized = sanitizer.compressHTMLEntities( writeEmbed.templateFn( data ) );
  stores.publish.write( embedPath, sanitized, callback );
}

app.post( '/api/publish/:id',
  filter.isLoggedIn, filter.isStorageAvailable,
  function publishRoute( req, res ) {

  var email = req.session.email,
      id = parseInt( req.params.id, 10 );

  if ( isNaN( id ) ) {
    res.json( { error: "ID was not a number" }, 500 );
    return;
  }

  Project.find( { id: id, email: email }, function( err, project ) {
    if ( err ) {
      res.json( { error: err }, 500);
      return;
    }

    if ( !project ) {
      res.json( { error: 'project not found' }, 404);
      return;
    }

    var i = 0,
        template = project.template;

    if( !( template && VALID_TEMPLATES[ template ] ) ) {
      res.json({ error: 'template not found' }, 500);
      return;
    }

    var projectData = JSON.parse( project.data, sanitizer.escapeHTMLinJSON ),
        templateConfig = templateConfigs[ template ],
        templateFile = templateConfig.template,
        baseHref;

    fs.readFile( templateFile, 'utf8', function( err, data ){
      if ( err ) {
        res.json( { error: 'error reading template file' }, 500 );
        return;
      }

      var headEndTagIndex,
          bodyEndTagIndex,
          externalAssetURL = '',
          externalAssetsString = '',
          popcornString = '',
          currentMedia,
          currentTrack,
          currentTrackEvent,
          mediaPopcornOptions,
          templateURL,
          baseString,
          headStartTagIndex,
          templateScripts,
          startString,
          numSources,
          j, k, len;

      templateURL = templateFile.substring( templateFile.indexOf( '/templates' ), templateFile.lastIndexOf( '/' ) );
      baseHref = APP_HOSTNAME + templateURL + "/";
      baseString = '\n  <base href="' + baseHref + '"/>';

      // look for script and link tags with data-butter-exclude in particular (e.g. butter's js script)
      data = data.replace( /\s*<(script|link|meta)[\.\/='":,_\-\w\s]*data-butter-exclude[\.\/='":_\-\w\s]*>(<\/script>)?/g, '' );

      // Adding  to cut out the actual head tag
      headStartTagIndex = data.indexOf( '<head>' ) + 6;
      headEndTagIndex = data.indexOf( '</head>' );
      bodyEndTagIndex = data.indexOf( '</body>' );

      templateScripts = data.substring( headStartTagIndex, headEndTagIndex );
      startString = data.substring( 0, headStartTagIndex );

      // If the template has custom plugins defined in it's config, add them to our exported page
      if ( templateConfig.plugin && templateConfig.plugin.plugins ) {
        var plugins = templateConfig.plugin.plugins;
        for ( i = 0, len = plugins.length; i < len; i++ ) {
          externalAssetURL = utils.pathToURL( APP_HOSTNAME + '/' + plugins[ i ].path.split( '{{baseDir}}' ).pop() );
          externalAssetsString += '\n  <script src="' + externalAssetURL + '"></script>';
        }
        externalAssetsString += '\n';
      }

      popcornString += '<script>';

      for ( i = 0; i < projectData.media.length; ++i ) {
        var mediaUrls,
            mediaUrlsString = '[ "';

        currentMedia = projectData.media[ i ];
        // We expect a string (one url) or an array of url strings.
        // Turn a single url into an array of 1 string.
        mediaUrls = typeof currentMedia.url === "string" ? [ currentMedia.url ] : currentMedia.url;
        mediaPopcornOptions = currentMedia.popcornOptions || {};
        // Force the Popcorn instance we generate to have an ID we can query.
        mediaPopcornOptions.id = "Butter-Generated";

        numSources = mediaUrls.length;

        for ( k = 0; k < numSources - 1; k++ ) {
          mediaUrlsString += mediaUrls[ k ] + '" , "';
        }
        mediaUrlsString += mediaUrls[ numSources - 1 ] + '" ]';

        // src/embed.js initializes Popcorn by executing the global popcornDataFn()
        popcornString += '\nvar popcornDataFn = function(){';
        popcornString += '\nvar popcorn = Popcorn.smart("#' + currentMedia.target + '", ' +
                         mediaUrlsString + ', ' + JSON.stringify( mediaPopcornOptions ) + ');';
        for ( j = 0; j < currentMedia.tracks.length; ++ j ) {
          currentTrack = currentMedia.tracks[ j ];
          for ( k = 0; k < currentTrack.trackEvents.length; ++k ) {
            currentTrackEvent = currentTrack.trackEvents[ k ];
            popcornString += '\npopcorn.' + currentTrackEvent.type + '(';
            popcornString += JSON.stringify( currentTrackEvent.popcornOptions, null, 2 );
            popcornString += ');';
          }
        }
        popcornString += '};\n';
      }
      popcornString += '</script>\n';

      data = startString + baseString + templateScripts + externalAssetsString +
             data.substring( headEndTagIndex, bodyEndTagIndex ) +
             popcornString + data.substring( bodyEndTagIndex );

      // Convert 1234567890 => "kf12oi"
      var idBase36 = utils.generateIdString( id ),
          publishUrl = utils.generatePublishUrl( id ),
          iframeUrl = utils.generateIframeUrl( id );

      function finished( err ) {
        if ( err ) {
          res.json({ error: 'internal server error' }, 500);
        } else {
          res.json({ error: 'okay', publishUrl: publishUrl, iframeUrl: iframeUrl });
          metrics.increment( 'project.publish' );
        }
      }

      function publishEmbedShell() {
        // Write out embed shell HTML
        writeEmbedShell( idBase36, publishUrl,
                         {
                           author: project.author,
                           projectName: project.name,
                           description: project.description,
                           embedShellSrc: publishUrl,
                           embedSrc: iframeUrl,
                           baseHref: APP_HOSTNAME,
                           thumbnail: project.thumbnail
                         },
                         finished );
      }

      // This is a query string-only URL because of the <base> tag
      var remixUrl = "?savedDataUrl=/api/remix/" + project.id,
          mediaUrl = projectData.media[ 0 ].url,
          attribURL = Array.isArray( mediaUrl ) ? mediaUrl[ 0 ] : mediaUrl;

      writeEmbed( idBase36 + utils.constants().EMBED_SUFFIX, iframeUrl,
                  {
                    id: id,
                    author: project.author,
                    title: project.name,
                    description: project.description,
                    mediaSrc: attribURL,
                    embedShellSrc: publishUrl,
                    baseHref: baseHref,
                    remixUrl: remixUrl,
                    templateScripts: templateScripts,
                    externalAssets: externalAssetsString,
                    popcorn: popcornString,
                    thumbnail: project.thumbnail
                  },
                  publishEmbedShell );

    });
  });
});

app.get( '/dashboard', middleware.isAuthenticated, filter.isStorageAvailable, function( req, res ) {
  res.redirect( config.AUDIENCE + "/myprojects?app=popcorn&email=" + req.session.email );
});

app.get( '/external/make-api.js', function( req, res ) {
  res.sendfile( path.resolve( __dirname, "node_modules/makeapi/public/js/make-api.js" ) );
});

app.get( '/api/butterconfig', function( req, res ) {
  res.json({
    "makeEndpoint": config.MAKE_ENDPOINT,
    "audience": config.AUDIENCE
  });
});

app.listen( port, function() {
  console.log( 'HTTP Server started on ' + APP_HOSTNAME );
  console.log( 'Press Ctrl+C to stop' );
});
