var ProgressBar = require('progress'),
	chalk = require('chalk'),
	util = require('./util'),
	errorlib = require('./error'),
	urllib = require('url'),
	fs = require('fs'),
	os = require('os'),
	path = require('path'),
	tmpdir = os.tmpdir(),
	MAX_RETRIES = 5,
	pendingRequest;

function download(force, wantVersion, tmpfile, stream, location, callback, nobanner, retryAttempts) {
	if (!nobanner && !wantVersion) { util.waitMessage('Finding latest version ...'); }
	if (!nobanner && wantVersion) { util.waitMessage('Finding version '+wantVersion+' ...'); }
	retryAttempts = retryAttempts || 1;
	pendingRequest = util.request(location, function(err,res,req){
		if (err) {
			if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
				pendingRequest = null;
				util.resetLine();
				return setTimeout(function() {
					download(force, wantVersion, tmpfile, stream, location, callback, true, retryAttempts+1);
				},5000);
			}
			return callback(errorlib.createError('com.appcelerator.install.download.server.response.error',err.message));
		}
		// console.log(res);
		if (res.statusCode===301 || res.statusCode===302) {
			// handle redirect
			location = res.headers.location;
			pendingRequest = null;
			util.resetLine();
			return download(tmpfile, stream, location, callback, nobanner);
		}
		else if (res.statusCode===404) {
			pendingRequest = null;
			return callback(errorlib.createError('com.appcelerator.install.download.version.specified.incorrect',wantVersion));
		}
		else if (res.statusCode===200) {
			var version = res.headers['x-appc-version'],
				shasum = res.headers['x-appc-shasum'],
				hash = require('crypto').createHash('sha1');

			hash.setEncoding('hex');

			if (!nobanner && !wantVersion) { util.okMessage(chalk.green(version)); }
			if (!nobanner && wantVersion) { util.okMessage(); }

			// check to see if we have it already installed and if we do, just continue
			if (!force && version) {
				var bin = util.getInstallBinary(null, version);
				if (bin) {
					return callback(null, null, version, bin);
				}
			}

			var total = parseInt(res.headers['content-length'], 10);

			if (!total) {
				return callback(errorlib.createError('com.appcelerator.install.download.invalid.content.length'));
			}

			var bar = new ProgressBar('Downloading [:bar] :percent :etas', {
					complete: chalk.green(util.isWindows()?'█':'▤'),
					incomplete: chalk.gray(' '),
					width: Math.max(40, Math.round(process.stdout.columns/2)),
					total: total,
					clear: true
				}),
				count = 0;

			util.stopSpinner();

			res.on('data', function (chunk) {
				if (chunk.length) {
					bar.tick(chunk.length);
					stream.write(chunk);
					hash.update(chunk);
					count+=chunk.length;
				}
			});

			res.on('error', function(err){
				try {
					stream.end();
				}
				catch (E) {
				}
				pendingRequest = null;
				callback(errorlib.createError('com.appcelerator.install.download.server.stream.error',err.message));
			});

			res.on('end', function () {
				stream.end();
				pendingRequest = null;
				// check to make sure we downloaded all the bytes we needed too
				// if not, this means the download failed and we should attempt to re-start it
				if (count !== total) {
					bar.terminate();
					stream.end();
					util.resetLine();
					if (retryAttempts >= MAX_RETRIES) {
						return callback(errorlib.createError('com.appcelerator.install.download.failed.retries.max',retryAttempts));
					}
					// re-open stream
					stream = fs.createWriteStream(tmpfile);
					var delay = retryAttempts * 2000;
					// download failed, we should re-start
					return setTimeout(function(){
						download(force, wantVersion, tmpfile, stream, location, callback, true, retryAttempts+1);
					},delay);
				}
				hash.end();
				var checkshasum = hash.read();
				// our downloaded file checksum should match what we uploaded, if not, this is a security violation
				if (checkshasum!==shasum) {
					return callback(errorlib.createError('com.appcelerator.install.download.failed.checksum',shasum,checkshasum));
				}
				else {
					util.infoMessage('Validating security checksum '+chalk.green(util.isWindows()?'OK':'✓'));
				}
				process.nextTick(function(){
					callback(null, tmpfile, version);
				});
			});
		}
		else if (/^(408|500|503)$/.test(String(res.statusCode))) {
			// some sort of error on the server, let's re-try again ...
			// 408 is a server timeout
			// 500 is a server error
			// 503 is a server unavailable. this could be a deployment in progress
			stream.end();
			util.resetLine();
			pendingRequest = null;
			if (retryAttempts >= MAX_RETRIES) {
				return callback(errorlib.createError('com.appcelerator.install.download.server.unavailable'));
			}
			var delay = retryAttempts * 2000;
			stream = fs.createWriteStream(tmpfile);
			return setTimeout(function() {
				download(force, wantVersion, tmpfile, stream, location, callback, true, retryAttempts+1);
			},delay);
		}
		else {
			stream.end();
			util.resetLine();
			pendingRequest = null;
			return callback(errorlib.createError('com.appcelerator.install.download.server.response.unexpected',res.statusCode));
		}
	});
}

exports.start = function(force, location, wantVersion, callback) {
	var tmpfile = path.join(tmpdir, 'appc-'+(+new Date())+'.tar.gz'),
		stream = fs.createWriteStream(tmpfile),
		exitFn,
		sigintFn,
		pendingAbort,
		createCleanup = function createCleanup(name) {
			return function(exit) {
				if (pendingRequest) {
					try {
						// abort the pending HTTP request so it will
						// close the server socket
						pendingRequest.abort();
					}
					catch (E) {
					}
					pendingRequest = null;
				}
				try {
					if (fs.existSync(tmpfile)) {
						fs.unlinkSync(tmpfile);
					}
				}
				catch (E) {
				}
				if (name==='SIGINT') {
					pendingAbort = true;
					process.removeListener('SIGINT',sigintFn);
					util.abortMessage('Download');
				}
				else if (name==='exit') {
					process.removeListener('exit',exitFn);
					if (!pendingAbort) {
						process.exit(exit);
					}
				}
				else {
					process.removeListener('exit',exitFn);
					process.removeListener('SIGINT',sigintFn);
				}
			};
		};

	// make sure we remove the file on shutdown
	process.on('exit', (exitFn=createCleanup('exit')));
	process.on('SIGINT', (sigintFn=createCleanup('SIGINT')));

	// run the download
	download(force, wantVersion, tmpfile, stream, location, function(){
		// remove clean listeners
		createCleanup('done')();
		// carry on... 🙏
		return callback.apply(null,arguments);
	});
};
