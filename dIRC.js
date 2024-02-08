const { WebSocket } = require('ws');
const config = require('./config.json');
const debug = Boolean(config.debug || process.env.DEBUG);

const users = {}, friends = {}, privateChannels = {};
let heartbeatInterval, heartbeatTermId, heartbeatSendId, lastSequence; // heartbeat-centered vars
let borkedTokenId, welcomed;
let currentChannel;
let usernameLength;
let ws;

function init() {
	ws.on('error', console.error);

	ws.on('open', () => {
		debugLog(`>> Connection open`);
		ws.send(JSON.stringify({op:2,d:{token:config.token,capabilities:16381,properties:{os:'Linux',browser:'dIRC',device:'',system_locale:'en-US',browser_user_agent:'Możilla/4.1 (X12; Linux x68_46; rv:69.0) Gecko/00000000 Firefox/69.0',browser_version:'69.0',os_version:'',referrer:'',referring_domain:'',referrer_current:'',referring_domain_current:'',release_channel:'stable',client_build_number:260101,client_event_source:null},presence:{status:'online',since:0,activities:[],afk:false},compress:false,client_state:{guild_versions:{},highest_last_message_id:'0',read_state_version:0,user_guild_settings_version:-1,private_channels_version:'0',api_code_version:0}}}));
		borkedTokenId = setTimeout(() => {
			console.log('Authentication failed. Exiting.');
			ws.close();
			process.exit(1);
		}, 10000);
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
				if(!welcomed) {
					console.log(`Welcome to dIRC, ${json.d.user.username}!`);
					usernameLength = json.d.user.username.length;
					welcomed = true;
				}
				clearTimeout(borkedTokenId);
				json.d.users.forEach(u => users[u.id] = u.username);
				json.d.private_channels.filter(ch => ch.type == 1).forEach(ch => privateChannels[ch.recipient_ids[0]] = ch.id);
				json.d.relationships.forEach(fr => friends[fr.id] = users[fr.id]);
				debugLog(`>> Saved ${Object.keys(json.d.users).length} user id mappings`);
				debugLog(`>> Saved ${Object.keys(privateChannels).length} private channel ids`);
				debugLog(`>> Saved ${Object.keys(friends).length} friend ids`);
				break;

			case 'PRESENCE_UPDATE':
				let username = users[json.d.user.id] ?? json.d.user.id;
				let status = json.d.status;
				let platformStatus = Object.entries(json.d.client_status).map(([k, v]) => `${v} on ${k}`).join(', ');
				let activity = json.d.activities;
				// console.log(`\t\t ${username} is now ${status} (${platformStatus}) and has ${activity.length} activities`);
				break;

			case 'CHANNEL_CREATE':
			case 'CHANNEL_DELETE':
				// if(json.d.type == 1)
				// 	if(json.t == 'CHANNEL_CREATE')
				// 		privateChannels.add(json.d.id);
				// 	else
				// 		privateChannels.delete(json.d.id);
				// break;

			case 'TYPING_START':
			case 'MESSAGE_DELETE':
			// case 'CHANNEL_DELETE':
			// case 'GUILD_BAN_ADD':
			// case 'GUILD_AUDIT_LOG_ENTRY_CREATE':
			case 'MESSAGE_CREATE': //
			case 'MESSAGE_UPDATE': //
				let uid = json.d.author?.id ?? json.d.user_id ?? 'ð';
				// if(offlineUsers[uid]) {
					// console.log(`\t\t ${users[uid] ?? uid} is ${typeof offlineUsers[uid] == 'number'? 'still' : 'now'} invisible (detected) and has 0 activities`);
					// offlineUsers[uid] = 1;
				// }
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

	if(!welcomed)
		return;

	if(stdinForward)
		return stdinForward(key);

	// [o]pen a channel
	if(key == 'o') {
		return input('$init', 'Open', 'searching by username', Object.values(friends), async data => {
			let uid = Object.entries(users).filter(([id, user]) => user == data)[0][0];
			currentChannel = {uid};
			if(!privateChannels[uid]) {
				// Create the DM channel
				let channelData = await fetch('https://discord.com/api/v9/users/@me/channels', {
					body: JSON.stringify({recipients:[uid]}),
					method: 'POST',
					headers: {
						'User-Agent': 'dIRC/1.0',
						'Content-Type': 'application/json',
						Authorization: config.token
					}
				});
				currentChannel.id = (await channelData.json()).id;
			} else currentChannel.id = privateChannels[uid];
			// Fetch the channel history
			let channelHistory = await fetch(`https://discord.com/api/v9/channels/${currentChannel.id}/messages?limit=50`, {
				headers: {
					'User-Agent': 'dIRC/1.0',
					Authorization: config.token
				}
			});
			currentChannel.history = await channelHistory.json();
			console.log();
			for(var i = currentChannel.history.length - 1; i >= 0; --i)
				printMessage(currentChannel.history[i]);
		});
	} else if(key == 'C') {
		return input('$init', 'Color for', 'searching by username', Object.values(friends), data => {
			let uid = Object.entries(users).filter(([id, user]) => user == data)[0][0];
			input('$init', 'Color', '8-bit color code', [], clr => {
				let color = +clr;
				if(isNaN(color) || color < 0 || color > 255)
					console.log('Invalid 8-bit color code, if you need a list, well, TODO'); // TODO `for i in $(seq 0 255); do printf "\x1b[38;5;${i}mA"; done`
				config.colors[uid] = color;
				yesno('$init', 'Recolor current conversation history', true, redraw => {
					if(!redraw)
						return;

					// TODO: this sucks lol
					console.log('\n'.repeat(10));
					for(var i = currentChannel.history.length - 1; i >= 0; --i)
						printMessage(currentChannel.history[i]);
				});
			});
		});
	}
});

// TODO: color coding per username for easier distinguishing
function printMessage(message) {
	let c = (message.attachments.length > 0? '[&' + message.attachments.map(at => at.filename).join(', ') + '] ' : '') + message.content;
	if(c.trim() == '')
		c = JSON.stringify(message); // shouldn't happen.
	let pad = Math.max(usernameLength, message.author.username.length);
	console.log(`${getColor(message.author.id)}${message.author.username.padEnd(pad)} ${c}${resetColor}`);
}

const resetColor = '\x1b[0m';
function getColor(uid) {
	if(config.colors[uid] == undefined)
		config.colors[uid] = Math.floor(Math.random() * 216) + 16;

	return `\x1b[38;5;${config.colors[uid]}m`;
}

let searchPrompt, searchPhrase, searchId, searchSuggestions, searchCallback, searchPossible;
function input(char, prompt, rest, possible, callback) {
	if(char == '$init') {
		stdinForward = input;
		process.stdout.write(`${prompt}: [${rest}]\r`);
		searchPrompt = prompt;
		searchPhrase = '';
		searchCallback = data => {
			stdinForward = undefined;
			process.stdout.write(' '.repeat(50) + '\r');
			callback(data);
		};
		searchId = false;
		searchSuggestions = [];
		searchPossible = possible;
		return;
	}

	// console.log('\n' + char.charCodeAt(0).toString(16).padStart(2, '0') + '\n');
	if(char == '\x1b') { // ESC
		stdinForward = null;
		process.stdout.write(' '.repeat(50) + '\r');
		return;
	}

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
	process.stdout.write(`${searchPrompt}: ${searchId? '$' : ''}${searchPhrase} ${s1? `[~${s1}` : ''}${s2? ` @${s2}` : ''}${s3? ` #${s3}` : ''}${s1? ']' : ''}${' '.repeat(50)}\r`);
}

let yesnoCallback, yesnoDefault;
function yesno(char, prompt, _default, callback) {
	if(char == '$init') {
		stdinForward = yesno;
		process.stdout.write(`${prompt}? [${_default? 'Y' : 'y'}/${_default? 'n' : 'N'}]${' '.repeat(50)}\r`);
		yesnoCallback = callback;
		yesnoDefault = _default;
		return;
	}

	if(char == '\x1b') { // ESC
		stdinForward = null;
		process.stdout.write(' '.repeat(50) + '\r');
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
	if(debug)
		console.log(`\x1b[38;5;8m${m}${resetColor}`);
}

restart();