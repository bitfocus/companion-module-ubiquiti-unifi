const instance_skel = require('../../instance_skel');
const unifi = require('node-unifiapi');
const async = require('async');

class instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config);

		this.commandQueue = [];
		this.waiting = false;

		this.actions(); // export actions
	}

	updateConfig(config) {
		this.config = config;

		this.status(this.STATE_OK);

		if (this.controller !== undefined) {
			this.controller.logout();
			delete this.controller;
		}
		this.controller = unifi({
			baseUrl: 'https://'+this.config.host+':'+this.config.port, // The URL of the Unifi Controller
			username: this.config.username,
			password: this.config.password,
			//debug: true, // More debug of the API (uses the debug module)
			//debugNet: true // Debug of the network requests (uses request module)
		});
	}

	init() {
		this.status(this.STATE_OK);

		this.controller = unifi({
			baseUrl: 'https://'+this.config.host+':'+this.config.port, // The URL of the Unifi Controller
			username: this.config.username,
			password: this.config.password,
			//debug: true, // More debug of the API (uses the debug module)
			//debugNet: true // Debug of the network requests (uses request module)
		});

		this.startTransmitTimer();
	}

	config_fields() {
		return [
			{
				type: 'text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This module will control network switches via a UniFi controller.'
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP/Host',
				width: 12,
				required: true
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Target Port',
				width: 12,
				regex: this.REGEX_PORT,
				default: "8443",
				required: true
			},
			{
				type: 'text',
				id: 'info',
				width: 12,
				label: 'Username/Password',
				value: 'These will be stored in clear text within the Companion config.<br>It is encouraged that you create a unique username and password for this instance.'
			},
			{
				type: 'textinput',
				id: 'username',
				label: 'Username',
				width: 12,
				required: true
			},
			{
				type: 'textinput',
				id: 'password',
				label: 'Password',
				width: 12,
				required: true
			}
		]
	}

	destroy() {
		this.debug("destroy");
		if(this.controller !== undefined){
			this.controller.logout();
		}
		this.stopTransmitTimer();
	}

	actions(system) {
		this.setActions({
			'POECycle': {
				label: 'Power Cycle POE Switchport',
				options: [
					{
						type: 'textinput',
						label: 'Site',
						id: 'site',
						default: 'default'
					},
					{
						type: 'textinput',
						label: 'Switch Mac Address',
						id: 'mac',
						default: ''
					},
					{
						type: 'textinput',
						label: 'Port',
						id: 'port',
						default: ''
					}
				]
			},
			'POEMode': {
				label: 'Switchport POE Mode',
				options: [
					{
						type: 'textinput',
						label: 'Site',
						id: 'site',
						default: 'default'
					},
					{
						type: 'textinput',
						label: 'Switch Mac Address',
						id: 'mac',
						default: ''
					},
					{
						type: 'textinput',
						label: 'Port',
						id: 'port',
						default: ''
					},
					{
						type: 'dropdown',
						label: 'Mode',
						id: 'mode',
						choices: [
							{id: 'auto', label: 'Auto'},
							{id: 'pasv24', label: '24V Passive'},
							{id: 'off', label: 'Off'}
						]
					}
				]
			}
		});
	}

	action(action) {
		let opt = action.options;
		this.debug('action: ', action);

		switch (action.action) {
			case 'POECycle':
				this.commandQueue.push({function:this.PowerCyclePort, args:[opt.site, opt.mac, opt.port]});
				break;
			case 'POEMode':
				this.commandQueue.push({function:this.changePOEMode, args:[opt.site, opt.mac, opt.port, opt.mode]});
				break;
		}
	}

	startTransmitTimer() {
		var timeout = 100;

		// Stop the timer if it was already running
		this.stopTransmitTimer();

		this.log('debug', "Starting transmit timer");
		// Create a timer to transmit commands to the controller
		this.transmitTimer = setInterval( async () => {
			if(!this.waiting){
				if(this.commandQueue.length > 0){
					this.waiting = true;
					let currentCommand = await this.commandQueue.shift();
					await currentCommand['function'].apply(this, currentCommand['args']);
					this.waiting = false;
				}
			}
		}, timeout);
	}

	stopTransmitTimer() {
		if (this.transmitTimer !== undefined) {
			this.log('debug', "Stopping connection timer");
			clearInterval(this.transmitTimer);
			delete this.transmitTimer;
		}

	}

	async PowerCyclePort(site, mac, port){
		let payload = {mac: mac.toLowerCase(),
			port_idx:'1',
			cmd: 'power-cycle'
		};

		await this.customCommand("/cmd/devmgr", payload, site, 'POST')
		.then(() =>{
			this.status(this.STATE_OK);
			return
		})
		.catch((err) => {
			let msg = "";
			if(err.meta != undefined){
				msg = err.meta.msg;
			}
			else if(typeof err === 'string'){
				if(err.includes('ETIMEDOUT') || err.includes('EHOSTDOWN')){
					msg = 'Host not found';
				}
				else{
					msg = err;
				}
			}
			else{
				msg = err.msg;
			}

			this.log('error', 'ERROR: ' + msg);
			this.status(this.STATE_ERROR);
		});
	}

	//async changePOEMode(site, mac, switchPort, poeMode){
	async changePOEMode(site, mac, switchPort, poeMode){
		await this.controller.list_aps(mac.toLowerCase(), site)
		.then((data) => {
				let devID = data['data'][0]['_id'];
				let payload = {'port_overrides': data['data'][0]['port_overrides']};

				let found = false;
				let changed = false;
				for (let port of payload['port_overrides']){
					if(port['port_idx'] == switchPort){
						found = true;
						if(port['poe_mode'] != poeMode){
							port['poe_mode'] = poeMode;
							changed = true;
						}
						break;
					}
				}

				if(!found){
					payload['port_overrides'].push(
						{
							'port_idx':Number(switchPort),
							'poe_mode':poeMode
						}
					);
					changed = true;
				}

				if(changed){
					return this.customCommand('/rest/device/' + devID, payload, site, 'PUT')
				}
				else{
					return
				}

			})
			.then(() => {
				this.status(this.STATE_OK);
				return
			})
			.catch((err) => {
				let msg = "";
				if(err.meta != undefined){
					msg = err.meta.msg;
				}
				else if(typeof err === 'string'){
					if(err.includes('ETIMEDOUT') || err.includes('EHOSTDOWN')){
						msg = 'Host not found';
					}
					else{
						msg = err;
					}
				}
				else{
					msg = err.msg;
				}

				if(msg == "api.err.NoSiteContext") {
					this.log('warn', 'Site "'+site+'" does not exist');
				}
				else if(msg == "api.err.UnknownDevice") {
					this.log('warn', 'Device "'+mac+'" does not exist');
				}
				else if(msg == "api.err.InvalidPayload"){
					this.log('warn', 'Invalid parameters');
				}
				else{
					this.log('error', 'ERROR: ' + msg);
					this.status(this.STATE_ERROR);
				}
			});
	}

	customCommand(path, payload, site = undefined, method) {
		return this.controller.netsite(path, payload, {}, method, site);
	}
}
exports = module.exports = instance;
