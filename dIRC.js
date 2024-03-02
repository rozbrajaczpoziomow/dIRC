import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { WebSocket } = require('ws');
const { createWriteStream, mkdirSync, existsSync } = require('node:fs');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { spawn } = require('node:child_process');
import mime from 'mime';
const Config = require('./config.json');

const Debug = Boolean(Config.debug || process.env.DEBUG);
const DisableColors = Boolean(Config.colors['$disable']);

const Users = {}, Friends = {}, PrivateChannels = {}, Presence = {};
let heartbeatInterval, heartbeatTermId, heartbeatSendId, lastSequence; // heartbeat-centered vars
let borkedTokenId, welcomed;
let currentChannel;
let usernameLength, ownUID;
let ws;

function init() {
	ws.on('error', console.error);

	ws.on('open', () => {
		debugLog(`>> Connection open`);
		ws.send(JSON.stringify({op:2,d:{token:Config.token,capabilities:16381,properties:{os:'Linux',browser:'dIRC',device:'',system_locale:'en-US',browser_user_agent:'Możilla/4.1 (X12; Linux x68_46; rv:69.0) Gecko/00000000 Firefox/69.0',browser_version:'69.0',os_version:'',referrer:'',referring_domain:'',referrer_current:'',referring_domain_current:'',release_channel:'stable',client_build_number:260101,client_event_source:null},presence:{status:'online',since:0,activities:[],afk:false},compress:false,client_state:{guild_versions:{},highest_last_message_id:'0',read_state_version:0,user_guild_settings_version:-1,private_channels_version:'0',api_code_version:0}}}));
		borkedTokenId = setTimeout(() => {
			console.log('Authentication failed. Exiting.');
			ws.close();
			process.exit(1);
		}, 10000);
		if(!welcomed)
			process.stdout.write('Logging in...\r');
	});

	ws.on('message', data => {
		let json = JSON.parse(data.toString());
		lastSequence = json.s;

		if(json.op == 10) { // First message in ws - set up heartbeat
			heartbeatInterval = json.d.heartbeat_interval;
			return setTimeout(() => {
				// https://discord.com/developers/docs/topics/gateway#sending-heartbeats
				ws.send(JSON.stringify({op: 1, d: lastSequence}));
				heartbeatSendId = setInterval(() => {
					ws.send(JSON.stringify({op: 1, d: lastSequence}));
					heartbeatTermId = setTimeout(restart, 1000);
				}, heartbeatInterval - 125);
			}, heartbeatInterval * Math.random());
		} else if(json.op == 11) { // Heartbeat response
			clearTimeout(heartbeatTermId);
		}

		switch(json.t) {
			case 'READY':
				clearTimeout(borkedTokenId);
				if(welcomed)
					break;

				console.log(`Welcome to dIRC, ${json.d.user.username}!`);
				usernameLength = json.d.user.username.length;
				ownUID = json.d.user.id;
				json.d.users.forEach(u => Users[u.id] = u.username);
				json.d.private_channels.filter(ch => ch.type == 1).forEach(ch => PrivateChannels[ch.recipient_ids[0]] = ch.id);
				json.d.relationships.forEach(fr => Friends[fr.id] = Users[fr.id]);
				debugLog(`>> Loaded ${Object.keys(json.d.users).length} user id mappings`);
				debugLog(`>> Loaded ${Object.keys(PrivateChannels).length} private channel ids`);
				debugLog(`>> Loaded ${Object.keys(Friends).length} friend ids`);
				welcomed = true;
				break;

			case 'READY_SUPPLEMENTAL':
				json.d.merged_presences.friends.forEach(fr => Presence[fr.user_id] = fr.status);
				debugLog(`>> Loaded ${json.d.merged_presences.friends.length} friend presences`);
				Object.keys(Friends).forEach(id => Presence[id] = Presence[id] ?? 'probably offline');
				break;

			case 'PRESENCE_UPDATE':
				if(!Friends[json.d.user.id] || json.d.status == Presence[json.d.user.id])
					break;

				Presence[json.d.user.id] = json.d.status;

				if(json.d.user.id != currentChannel?.uid)
					break;

				console.log(clearEnd(`${DisableColors? '' : resetColor}${Friends[json.d.user.id]} is now ${json.d.status}`));
				if(stdinForward)
					stdinForward('$reprompt');
				break;

			// case 'MESSAGE_DELETE':
			// case 'MESSAGE_UPDATE':
			case 'MESSAGE_CREATE':
				if(json.d.channel_id != currentChannel?.id)
					break;

				json.d['$seq'] = currentChannel.history.at(-1)['$seq'] + 1;
				printMessage(null, json.d); // we always want to print color here.
				process.stdout.write(resetColor);

				currentChannel.history.push(json.d);
				break;
		}
	});
}

function restart() {
	clearInterval(heartbeatSendId);
	clearTimeout(heartbeatTermId);
	if(ws) {
		ws.terminate();
		debugLog(`>> Connection restarting`);
	}
	ws = new WebSocket('wss://gateway.discord.gg/?encoding=json&v=9');
	init();
}

function printMessage(prev, message) {
	let needColor = !DisableColors && prev?.author?.id != message.author.id;
	let c =
		(message.referenced_message? `[^${currentChannel.history.filter(msg => msg.id == message.referenced_message.id)[0]?.['$seq'] ?? 'old'}] ` : '') +
		(message.attachments.length > 0? `[&${message.attachments.map(at => at.filename).join(', ')}] ` : '') +
		message.content;
	if(c.trim() == '')
		c = JSON.stringify(message); // shouldn't happen.
	let pad = Math.max(usernameLength, message.author.username.length);
	console.log(`${needColor? getColor(message.author.id) : ''}${`${message['$seq']}`.padEnd(3)} ${message.author.username.padEnd(pad)} ${c}`);
}

const resetColor = '\x1b[0m';
function getColor(uid) {
	if(Config.colors[uid] == undefined)
		Config.colors[uid] = Math.floor(Math.random() * 216) + 16;

	return getColorR(Config.colors[uid]);
}

function getColorR(raw) {
	return `\x1b[38;5;${raw}m`
}

function clearEnd(str) {
	return str + ' '.repeat(Math.max(0, process.stdout.columns - str.length));
}

// stdin-esque garbage

process.stdin.setRawMode(true);
let stdinForward;
process.stdin.on('data', buffer => {
	const key = buffer.toString();
	//          ^C               ^D           ^\
	if(key == '\x03' || key == '\x04' || key == '\x1c') {
		console.log('Caught interrupt, exiting.');

		if(ws)
			ws.terminate();

		process.exit(0);
	}

	if(key == '\x1b') { // ESC
		stdinForward = null;
		process.stdout.write(clearEnd('') + '\r');
		return;
	}

	if(!welcomed)
		return;

	if(stdinForward)
		return stdinForward(key);

	// [o]pen a channel
	if(key == 'o') {
		return autocompleteInput('$init', 'Open', 'searching by username', Object.values(Friends), async data => {
			let uid = Object.entries(Users).filter(([id, user]) => user == data)[0][0];
			currentChannel = {uid};
			if(!PrivateChannels[uid]) {
				// Create the DM channel
				let channelData = await fetch('https://discord.com/api/v9/users/@me/channels', {
					body: JSON.stringify({recipients:[uid]}),
					method: 'POST',
					headers: {
						'User-Agent': 'dIRC/1.0',
						'Content-Type': 'application/json',
						Authorization: Config.token
					}
				});
				currentChannel.id = (await channelData.json()).id;
			} else currentChannel.id = PrivateChannels[uid];
			// Fetch the channel history
			let channelHistory = await fetch(`https://discord.com/api/v9/channels/${currentChannel.id}/messages?limit=50`, {
				headers: {
					'User-Agent': 'dIRC/1.0',
					Authorization: Config.token
				}
			});
			currentChannel.history = await channelHistory.json();
			currentChannel.history.reverse();
			for(var i = 0; i < currentChannel.history.length; ++i) {
				currentChannel.history[i]['$seq'] = i + 1;
				printMessage(currentChannel.history[i - 1], currentChannel.history[i]);
			}
			process.stdout.write(resetColor);
		});
	} else if(key == 'C') { // [C]olor
		if(DisableColors)
			return console.log('Colors have been disabled via a config option.');
		const cb = data => {
			let uid = Object.entries(Users).filter(([id, user]) => user == data)[0][0];
			autocompleteInput('$init', 'Color', '8-bit color code, ? for list', [], clr => {
				if(clr == '?') {
					for(var i = 0; i < 256; ++i)
						process.stdout.write(`${getColorR(i)}${i} `);
					console.log(resetColor);
					return cb(data);
				}

				let color = +clr;
				if(isNaN(color) || color < 0 || color > 255)
					console.log(clearEnd('Invalid 8-bit color code'));
				Config.colors[uid] = color;
				yesnoInput('$init', 'Recolor current conversation history', true, redraw => {
					if(!redraw)
						return;

					console.log('\n'.repeat(Math.max(0, process.stdout.rows - currentChannel.history.length))); // good enough approximation
					for(var i = 0; i < currentChannel.history.length; ++i)
						printMessage(currentChannel.history[i - 1], currentChannel.history[i]);
					process.stdout.write(resetColor);
				});
			});
		}
		return autocompleteInput('$init', 'Color for', 'searching by username', Object.values(Friends), cb);
	} else if(key == 'w') { // [w]rite message
		if(currentChannel == null)
			return console.log('[o]pen a channel first');

		return messageInput('$init');
	} else if(key == 's') { // [s]tatus
		if(currentChannel == null)
			return console.log('[o]pen a channel first');

		console.log(clearEnd(`${Friends[currentChannel.uid]} is currently ${Presence[currentChannel.uid]}`));
	} else if(key == 'v') { // [v]iew attachment
		if(currentChannel == null)
			return console.log('[o]pen a channel first');

		return autocompleteInput('$init', 'View attachment for', 'number beside message', [], mid => {
			mid = +mid;

			if(isNaN(mid) || mid < 1 || mid > currentChannel.history.at(-1)['$seq'])
				return console.log(clearEnd('Message doesn\'t exist') + '\r');

			let message = currentChannel.history.filter(m => m['$seq'] == mid)[0];

			if(message == null)
				return console.log(clearEnd('Message doesn\'t exist') + '\r');

			if(message.attachments.length == 0)
				return console.log(clearEnd('Message doesn\'t have any attachments') + '\r');

			let cb = async aname => {
				let path = `attachments/${currentChannel.uid}/${message.id}`;
				let fpath = path + `/${aname}`;

				let filetype;
				if(existsSync(fpath)) {
					debugLog('Using version from fs, not redownloading')
					filetype = mime.getType(fpath);
				} else {
					let url = message.attachments.filter(at => at.filename == aname)[0].url;

					if(url.includes('&=&')) // webp conversion, fuck that shit.
						url = url.slice(0, url.indexOf('&=&'));

					let areq = await fetch(url, {
						headers: {
							'User-Agent': 'dIRC/1.0' // attachments don't need Authorization
						}
					});

					if(areq.status != 200)
						return console.log(clearEnd('Downloading attachment failed') + '\r');

					mkdirSync(path, { recursive: true, mode: 0o755 });

					let stream = createWriteStream(fpath);
					await finished(Readable.fromWeb(areq.body).pipe(stream));

					filetype = areq.headers.get('Content-Type');
				}

				// $$fp => fpath, $$tc => process.stdout.columns, $$tr => process.stdout.rows
				let ran = 0;
				for(let regex in Config.attachments) {
					// allow multiple commands to run if multiple regexes match, this is intended.
					if(filetype.match(regex)) {
						let [cmd, ...argv] = Config.attachments[regex].map(arg => arg.replaceAll('$$fp', fpath).replaceAll('$$tc', process.stdout.columns.toString()).replaceAll('$$tr', process.stdout.rows.toString()));
						let child = spawn(cmd, argv);

						child.stdout.on('data', b => {
							process.stdout.write(b.toString());
						});

						child.stderr.on('data', b => {
							process.stdout.write(b.toString());
						});

						++ran;
					}
				}

				debugLog(`Ran ${ran} command${ran == 1? '' : 's'}`);
			}

			if(message.attachments.length == 1)
				cb(message.attachments[0].filename);
			else
				autocompleteInput('$init', 'Select attachment', 'filename', message.attachments.map(at => at.filename), cb);
		});
	}
});

// input types

let messageWritten, messageReplying;
function messageInput(char) {
	let messageStart = `${DisableColors? '' : getColor(ownUID)}> `;
	if(char == '$init') {
		process.stdout.write(messageStart + '\r');
		stdinForward = messageInput;
		messageWritten = '';
		messageReplying = null;
		return;
	}
	if(messageReplying)
		messageStart += `^${messageReplying} `

	if(char == '$reprompt') {
		return process.stdout.write(`${messageStart}${messageWritten}\r`)
	} else if(char == '\x7f') { // backspace
		messageWritten = messageWritten.slice(0, -1);
	} else if(char == '\r' || char == '\n') {
		stdinForward = null;
		let send = {content: messageWritten};
		if(messageReplying)
			send.message_reference = {message_id: currentChannel.history.filter(m => m['$seq'] == messageReplying)[0]?.id};
		return fetch(`https://discord.com/api/v9/channels/${currentChannel.id}/messages`, {
			body: JSON.stringify(send),
			method: 'POST',
			headers: {
				'User-Agent': 'dIRC/1.0',
				'Content-Type': 'application/json',
				Authorization: Config.token
			}
		});
	} else if(char == '^' && messageWritten == '') {
		return autocompleteInput('$init', 'Reply to', 'number beside message, empty to clear/cancel', [], reply => {
			reply = +reply;
			messageReplying = isNaN(reply) || reply < 1 || reply > currentChannel.history.at(-1)['$seq']? null : reply;
			stdinForward = messageInput;
			messageInput('$reprompt');
		});
	} else {
		messageWritten += char;
	}
	process.stdout.write(clearEnd(`${messageStart}${messageWritten}`) + '\r');
}

let searchPrompt, searchPhrase, searchId, searchSuggestions, searchCallback, searchPossible;
function autocompleteInput(char, prompt, rest, possible, callback) {
	if(char == '$init') {
		stdinForward = autocompleteInput;
		process.stdout.write(`${prompt}: [${rest}]\r`);
		searchPrompt = prompt;
		searchPhrase = '';
		searchCallback = data => {
			stdinForward = undefined;
			process.stdout.write(clearEnd('') + '\r');
			callback(data);
		};
		searchId = false;
		searchSuggestions = [];
		searchPossible = possible;
		return;
	}

	if(char == '$reprompt')
		char = '';

	// console.log('\n' + char.charCodeAt(0).toString(16).padStart(2, '0') + '\n');
	if(char == '\n' || char == '\r')
		char = '~';

	if(char == '~' || char == '@' || char == '#') {
		if(searchPossible.length == 0)
			return searchCallback(searchPhrase);
		// Use suggestions
		let result = searchSuggestions['~@#'.indexOf(char)];
		if(result == undefined || result == '')
			return;
		return searchCallback(result);
	} else if(char == '$') {
		searchId = true;
		searchPhrase = '';
		// TODO: actually search for IDs or remove this altogether, because, well, why.
	} else if(char == '\x7f') { // backspace
		searchPhrase = searchPhrase.slice(0, -1);
	} else {
		searchPhrase += char;
	}

	if(searchPhrase == '' || searchPossible.length == 0)
		searchSuggestions = []
	else
		searchSuggestions = searchPossible.filter(fr => fr.includes(searchPhrase)).sort((a, b) => {
			// if one of them is the search phrase, obviously sort it first
			if(a == searchPhrase)
				return -1;
			if(b == searchPhrase)
				return 1;
			// if one of them starts with the search phrase but the other one doesn't
			if(a.startsWith(searchPhrase) && !b.startsWith(searchPhrase))
				return -1;
			if(b.startsWith(searchPhrase) && !a.startsWith(searchPhrase))
				return 1;
			// same as above but ends with, which is less important
			if(a.endsWith(searchPhrase) && !b.endsWith(searchPhrase))
				return -1;
			if(b.endsWith(searchPhrase) && !a.endsWith(searchPhrase))
				return 1;
			// if both are a form of ${garbage}${searchPhrase}${garbage}, prio whichever's shorter
			if(b.length > a.length)
				return -1;
			else if(a.length > b.length)
				return 1;
			// they're equal according to search ;p
			return 0;
		});

	let [s1, s2, s3] = searchSuggestions; // make it s h o r t e r / r e a d a b l e
	// TODO: don't use a set amount of spaces, check for last written length and add just enough.
	process.stdout.write(clearEnd(`${searchPrompt}: ${searchId? '$' : ''}${searchPhrase} ${s1? `[~${s1}` : ''}${s2? ` @${s2}` : ''}${s3? ` #${s3}` : ''}${s1? ']' : ''}`) + '\r');
}

let yesnoCallback, yesnoDefault;
function yesnoInput(char, prompt, _default, callback) {
	if(char == '$init' || char == '$reprompt') {
		process.stdout.write(clearEnd(`${prompt}? [${_default? 'Y' : 'y'}/${_default? 'n' : 'N'}]`) + '\r');

		if(char == '$reprompt')
			return;

		stdinForward = yesnoInput;
		yesnoCallback = callback;
		yesnoDefault = _default;
		return;
	}

	if(char == '\n' || char == '\r') {
		stdinForward = null;
		return yesnoCallback(yesnoDefault);
	}

	if(char.toLowerCase() == 'y' || char.toLowerCase() == 'n') {
		stdinForward = null;
		return yesnoCallback(char.toLowerCase() == 'y');
	}
}

function debugLog(m) {
	if(Debug)
		console.log(DisableColors? m : `\x1b[38;5;8m${m}${resetColor}`);
}

restart();