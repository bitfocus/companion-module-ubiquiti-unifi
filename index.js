const instance_skel = require('../../instance_skel');
const unifi = require('node-unifi');
const async = require('async');

class instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config);

		this.commandQueue = [];
		this.waiting = false;
		this.hostTimeout = 10000;

		this.actions(); // export actions
	}

	updateConfig(config) {
		this.config = config;

		this.status(this.STATE_OK);

		if (this.controller !== undefined) {
			delete this.controller;
		}

		this.controller = new unifi.Controller(this.config.host, this.config.port);
	}

	init() {
		this.status(this.STATE_OK);

		this.controller = new unifi.Controller(this.config.host, this.config.port);

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
			this.doLogout();
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
			},
			'ProfilePOEMode': {
				label: 'Profile POE Mode',
				options: [
					{
						type: 'textinput',
						label: 'Site',
						id: 'site',
						default: 'default'
					},
					{
						type: 'textinput',
						label: 'Profile Name',
						id: 'profile',
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
			case 'ProfilePOEMode':
				this.commandQueue.push({function:this.changePortProfilePOEMode, args:[opt.site, opt.profile, opt.mode]});
				break;
		}
	}

	startTransmitTimer() {
		var timeout = 100;

		// Stop the timer if it was already running
		this.stopTransmitTimer();

		this.log('debug', "Starting transmit timer");
		// Create a timer to transmit commands to the controller
		this.transmitTimer = setInterval(() => {
			if(!this.waiting){
				if(this.commandQueue.length > 0){
					this.waiting = true;
					let currentCommand = this.commandQueue.shift();
					currentCommand['function'].apply(this, currentCommand['args']);
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

	dologin() {
		return new Promise((resolve, reject) => {
			let timeoutTimer = setTimeout(() => {
				reject("Host_Timeout");
			}, this.hostTimeout);
			this.controller.login(this.config.username, this.config.password, function(err) {
				if(err) {
					clearInterval(timeoutTimer);
					reject(err);
				}
				else{
					clearInterval(timeoutTimer);
					resolve();
				}
			}.bind(this));
		});
	}

	doLogout() {
		return new Promise((resolve, reject) => {
			let timeoutTimer = setTimeout(() => {
				reject("Host_Timeout");
			}, this.hostTimeout);
			this.controller.logout(function(err) {
				if(err) {
					clearInterval(timeoutTimer);
					reject(err);
				}
				else{
					clearInterval(timeoutTimer);
					resolve();
				}
			}.bind(this));
		});
	}

	doPowerCyclePort(site, mac, port) {
		return new Promise((resolve, reject) => {
			let timeoutTimer = setTimeout(() => {
				reject("Host_Timeout");
			}, this.hostTimeout);
			this.controller.powerCycleSwitchPort(site, mac, port, async function(err) {
				if(err) {
					clearInterval(timeoutTimer);
					reject(err);
				}
				else{
					clearInterval(timeoutTimer);
					resolve();
				}
			}.bind(this));
		});
	}

	doGetPortOverrides(site, mac) {
		return new Promise((resolve, reject) => {
			let timeoutTimer = setTimeout(() => {
				reject("Host_Timeout");
			}, this.hostTimeout);
			this.controller.getAccessDevices(site, function(err, device){
				if(err) {
					clearInterval(timeoutTimer);
					reject(err);
				}
				else{
					if(device !== undefined && device.length > 0){
						if((device[0] !== undefined) && (device[0].length > 0)){
							if(device[0][0] !== undefined && device[0][0]['_id'] !== undefined){
								let portOverrides = {'port_overrides':device[0][0]['port_overrides']};
								clearInterval(timeoutTimer);
								resolve({'id': device[0][0]['_id'], 'portOverrides':portOverrides});
							}
							else{
								clearInterval(timeoutTimer);
								reject('api.err.UnknownDevice');
							}
						}
						else{
							clearInterval(timeoutTimer);
							reject('api.err.UnknownDevice');
						}
					}
					else{
						clearInterval(timeoutTimer);
						reject('api.err.UnknownDevice');
					}
				}
			}.bind(this), mac);
		});
	}

	doGetPortProfileConfig(site, profile) {
		return new Promise((resolve, reject) => {
			let timeoutTimer = setTimeout(() => {
				reject("Host_Timeout");
			}, this.hostTimeout);
			this.log("warn", "trying making request")
			this.controller.customApiRequest(site, "/api/s/<SITE>/rest/portconf", function(err, data){
				if(err) {
					this.log("warn", "request failed")
					clearInterval(timeoutTimer);
					reject(err);
				}
				else{
					this.log("warn", "more")
					data.forEach(site => {
						site.forEach(profile_entry => {
							console.log("Object Site: %s", profile_entry["name"]);
							if(profile_entry["name"] == profile){
								console.log("Object: %j", profile_entry);
								resolve(profile_entry);
							}
						})
					})
					reject('api.err.UnknownProfile');
				}
			}.bind(this));
		});
	}

	doSetPortProfileConfig(site, profile_id, obj) {
		console.log("Testing set")
		return new Promise((resolve, reject) => {
			let timeoutTimer = setTimeout(() => {
				reject("Host_Timeout");
			}, this.hostTimeout);
			this.log("warn", "trying making request")
			this.controller.customApiRequest(site, "/api/s/<SITE>/rest/portconf/"+profile_id, function(err, data){
				if(err) {
					this.log("warn", "update request failed")
					clearInterval(timeoutTimer);
					reject(err);
				}
				else{
					this.log("warn", "success")
					resolve();
				}
			}.bind(this), "PUT", obj);
		});
	}

	setDeviceSettings(site, id, portOverrides) {
		return new Promise((resolve, reject) => {
			let timeoutTimer = setTimeout(() => {
				reject("Host_Timeout");
			}, this.hostTimeout);
			this.controller.setDeviceSettingsBase(site, id, portOverrides, function(err){
				if(err) {
					clearInterval(timeoutTimer);
					reject(err);
				}
				else{
					clearInterval(timeoutTimer);
					resolve();
				}
			}.bind(this));
		});
	}

	async PowerCyclePort(site, mac, switchPort){
		let attributes = {
			'site':site,
			'mac':mac,
			'switchPort':switchPort
		}

		await this.dologin().then(() => {
			return this.doPowerCyclePort(site, mac, switchPort)
		}).then(() => {
			this.status(this.OK);
			return;
		}).catch((err) => {
			this.handleErrors(err, attributes);
		});

		await this.doLogout().then(() => {
		}).catch((err) => {
			this.handleErrors(err, attributes);
			return;
		});
	}

	async changePOEMode(site, mac, switchPort, poeMode){
		let attributes = {
			'site':site,
			'mac':mac,
			'switchPort':switchPort
		}
		await this.dologin().then(() => {
			return this.doGetPortOverrides(site, mac)
		}).then( (vars) => {
			let found = false;
			for (let port of vars['portOverrides']['port_overrides']){
				if(port['port_idx'] == switchPort){
					found = true;
					port['poe_mode'] = poeMode;
					break;
				}
			}

			if(!found){
				vars['portOverrides']['port_overrides'].push(
					{
						'port_idx':Number(switchPort),
						'poe_mode':poeMode
					}
				);
			}

			return(vars);

		}).then((vars) => {
			return this.setDeviceSettings(site, vars['id'], vars['portOverrides']);
		}).then(() => {
			this.status(this.OK);
			return;
		}).catch((err) => {
			this.handleErrors(err, attributes);

		});

		await this.doLogout().catch((err) => {
			this.handleErrors(err, attributes);
			return;
		});
	}

	async changePortProfilePOEMode(site, profile, poeMode){
		let attributes = {
			'site':site,
			'profile':profile,
			'poeMode':poeMode
		}
		this.log("warn", "trying stuff")
		await this.dologin().then(() => {
			return this.doGetPortProfileConfig(site, profile)
		}).then( (vars) => {
			console.log("returned after fetching config")
			console.log("test %s", vars)
			vars["poe_mode"] = poeMode
			console.log("About to dispatch")
			console.log("Updated config %s", vars)
			this.doSetPortProfileConfig(site, vars["_id"], vars)
			// resolve({});
			return ({})

		}).then(() => {
			this.status(this.OK);
			return;
		}).catch((err) => {
			this.handleErrors(err, attributes);

		});

		await this.doLogout().catch((err) => {
			this.handleErrors(err, attributes);
			return;
		});
	}

	handleErrors(err, attributes) {
		if(err == "api.err.Invalid"){
			this.log('error', 'Username or Password invalid');
			this.status(this.STATE_ERROR);
		}
		else if(err == 'api.err.LoginRequired'){
			this.log('error', 'Failed to login');
			this.status(this.STATE_ERROR);
		}
		else if(err == "api.err.NoSiteContext") {
			this.log('warn', 'Site "'+attributes['site']+'" does not exist');
		}
		else if(err == "api.err.UnknownDevice") {
			this.log('warn', 'Device "'+attributes['mac']+'" does not exist');
		}
		else if((err == "api.err.InvalidPayload") || (err == "api.err.InvalidTargetPort")) {
			this.log('warn', 'Port "'+attributes['switchPort']+'" does not exist or POE is not currently active on it');
		}
		else if(err == 'Host_Timeout'){
			this.log('error', 'ERROR: Host Timedout');
			this.status(this.STATE_ERROR);
		}
		else if(err.includes('EHOSTDOWN')){
			this.log('error', 'ERROR: Host not found');
			this.status(this.STATE_ERROR);
		}
		else {
			this.log('error', 'ERROR: ' + err);
			this.status(this.STATE_ERROR);
		}
	}
}
exports = module.exports = instance;
