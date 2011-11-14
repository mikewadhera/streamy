
var http           = require('http')
    ,url           = require('url')
    ,child_process = require('child_process')
    ,fs            = require('fs')
    ,argv          = require('optimist').argv
    ,port          = 9000;

// Options

var debug         = false;
var parallelism   = 1;
var sourceOptions = [];

var streamName;
var scriptPath;

// Helpers

var indexOfById = function (array, id) {
  for (var i = 0; i < array.length; i++) if (array[i].id == id) return i;
}

var removeById = function (array, id) {
  array.splice(indexOfById(array, id), 1);
}

// Server

var server = function () {
  // State

  var sources = [];

  var cores = [];
  var lastCoreId = 0;
  var coresWriteOffset = 0;

  var sinks = [];
  var lastSinkId = 0;
  var sinksWriteOffset = 0;

  // Sources

  var startSources = function () {
    for (var i = 0; i < sourceOptions.length; i++) {
      var options = sourceOptions[i];
      var source  = http.get(options, function (response) {
        response.setEncoding('utf8');
        response.on('data', notifyCores);
      });
      sources.push(source);
    }
  }

  var stopSources = function () {
    for (var source in sources) sources[source].abort();
    sources = [];
  }

  // Cores

  var nextCoreId = function () {
    return lastCoreId++;
  }

  var registerCore = function (core) {
    var core = {
      id: nextCoreId(),
      control: core,
      writable: core.stdin
    }
    cores.push(core);
    return core;
  }

  var unregisterCore = function (core) {
    removeById(cores, core.id);
  }

  var startCores = function () {
    for (var i = cores.length; i < parallelism; i++) startCore();
  }

  var startCore = function () {
    var core = child_process.spawn(scriptPath);
    core.stdout.setEncoding('utf8');
    core.stderr.setEncoding('utf8');
    core.stdout.on('data', notifySinks);
    core.stderr.on('data', function (error) {
      console.log(error);
    })
    core.on('exit', function (code, signal) {
      unregisterCore(core);
    })
    registerCore(core);
  }

  var stopCores = function () {
    for (var i = 0; i < cores.length; i++) {
      cores[i].control.kill();
    }
    cores = [];
    coresWriteOffset = 0;
  }

  var notifyCores = function (payload) {
    var core = cores[coresWriteOffset++ % cores.length];
    if (debug) console.log("Notifying Core " + core.id);
    if (core) core.writable.write(payload);
  }

  // Sinks

  var nextSinkId = function () {
    return lastSinkId++;
  }

  var registerSink = function (sink) {
    var sink = {
      id: nextSinkId(),
      writable: sink
    }
    sinks.push(sink);
    return sink;
  }

  var noSinksRegistered = function () {
    return sinks.length == 0;
  }

  var sinksRegistered = function () {
    return sinks.length > 0;
  }

  var notifySinks = function (payload) {
    var sink = sinks[sinksWriteOffset++ % sinks.length];
    if (debug) console.log("Notifying Sink " + sink.id);
    if (sink) sink.writable.write(payload);
  }

  var unregisterSink = function (sink) {
    removeById(sinks, sink.id);
  }

  // Lifecycle

  var serve = function (request, response) {
    var path = url.parse(request.url).pathname;

    if (path != ("/" + streamName)) {
      response.writeHead(404, { 'Content-Type' : 'text/plain' });
      response.write("404 Not Found\n");
      response.end();
      return;
    }

    var sink = registerSink(response);

    if (debug) console.log("Sink " + sink.id + " registered.");

    request.on('close', function () {
      unregisterSink(sink);
      if (debug) console.log("Sink " + sink.id + " unregistered.");
      if (noSinksRegistered()) {
        stopSources();
        stopCores();
        sinksWriteOffset = 0;
      }
    });
  }

  var watch = function () {
    if (debug) console.log("Sources: " + sources.length);
    if (debug) console.log("Cores  : " + cores.length);
    if (debug) console.log("Sinks  : " + sinks.length);

    if (sinksRegistered()) {
      if (cores.length < parallelism) {
        if (debug) console.log("Starting Cores");
        startCores();
      }

      if (sources.length == 0) {
        if (debug) console.log("Starting Sources");
        startSources();    
      }      
    }
    
  };

  setInterval(watch, 2000);

  return serve;
}


// [--port <port>]
if (argv.port) port = argv.port;
// [--debug]
if (argv.debug) debug = argv.debug;
// [--parallelism <count>]
if (argv.parallelism) parallelism = argv.parallelism;
// [--source http://host:port/path]*
if (argv.source) { 
  var sources = [];
  if (argv.source instanceof Array) {
    sources = argv.source;
  } else {
    sources = new Array(argv.source);
  }
  for (var i in sources) sourceOptions.push(url.parse(sources[i]));
}

streamName = argv._[0];

if (streamName) {
  scriptPath = "./scripts/" + streamName;
  fs.stat(scriptPath, function (err, stats) {
    if (stats && stats.mode > 33200) {
      http.createServer(server()).listen(port);
      console.log("Stream " + streamName + " started (" + "parallelism: " + parallelism + "). Listening on: " + port);
      for (var i in sources) console.log("  Source: " + sources[i]);
    } else {
      console.log("Error: Unable to load " + scriptPath + " - are you sure its executable?");
    }
  });
} else {
  console.log("Error: Missing stream - " + argv['$0'] + " <stream>");
}
