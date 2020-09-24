const instance_skel = require('../../instance_skel');
var unifi = require('node-unifi');

class instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config);

		this.actions(); // export actions
	}

	updateConfig(config) {
		this.config = config;

		this.status(this.STATE_OK);

		this.controller = new unifi.Controller(this.config.host, this.config.port);
	}

	init() {
		this.status(this.STATE_OK);

		this.controller = new unifi.Controller(this.config.host, this.config.port);
	}

	config_fields() {
		return [
			{
				type: 'text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This module will control switches via UniFi controller.'
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 12,
				regex: this.REGEX_IP,
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
			},
			{
				type: 'textinput',
				id: 'password',
				label: 'Password',
				width: 12,
			}
		]
	}

	destroy() {
		this.debug("destroy");
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
				this.doPowerCyclePort(opt.site, opt.mac, opt.port);
				break;
			case 'POEMode':
				this.doPOEMode(opt.site, opt.mac, opt.port, opt.mode);
				break;
		}
	}

	doPowerCyclePort(site, mac, port){
		this.controller.login(this.config.username, this.config.password, function(err) {

			if(err) {
				if(err == "api.err.Invalid"){
					this.log('error', 'Username or Password invalid');
				}
				else{
					this.log('error', 'ERROR: ' + err);
				}
				this.status(this.STATE_ERROR);
				this.controller.logout();
				return;
			}

			this.controller.powerCycleSwitchPort(site, mac, port, function(err) {
				if(err) {
					if(err == "api.err.NoSiteContext") {
						this.log('warn', 'Site "'+site+'" does not exist');
					}
					else if(err == "api.err.UnknownDevice") {
						this.log('warn', 'Device "'+mac+'" does not exist');
					}
					else if(err == "api.err.InvalidTargetPort") {
						this.log('warn', 'Port "'+port+'" does not exist');
					}
					else {
						this.log('error', 'ERROR: ' + err);
					}
				}
				this.controller.logout();
			}.bind(this));
		}.bind(this));
	}

	doPOEMode(site, mac, switchPort, poeMode){
		this.controller.login(this.config.username, this.config.password, function(err) {
			if(err) {
				if(err == "api.err.Invalid"){
					this.log('error', 'Username or Password invalid');
				}
				else{
					this.log('error', 'ERROR: ' + err);
				}
				this.status(this.STATE_ERROR);
				return;
			}

			this.controller.getAccessDevices(site, function(err, device){
				if(err) {
					if(err == "api.err.NoSiteContext") {
						this.log('warn', 'Site "'+site+'" does not exist');
					}
					else if(err == "api.err.UnknownDevice") {
						this.log('warn', 'Device "'+mac+'" does not exist');
					}
					else {
						this.log('error', 'ERROR: ' + err);
					}
					this.controller.logout;
					return;
				}

				if(device != undefined){
					if(device.length > 0){
						if(device[0] != undefined){
							if(device[0].length > 0){
								if(device[0][0] != undefined){
									if(device[0][0]['_id'] != undefined){
										let payload = {'port_overrides':device[0][0]['port_overrides']};

										let found = false;
										for (let port of payload['port_overrides']){
											if(port['port_idx'] == switchPort){
												found = true;
												port['poe_mode'] = poeMode;
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
										}

										this.controller.setDeviceSettingsBase(site, device[0][0]['_id'], payload, function(err){
											if(err) {
												if(err == "api.err.InvalidPayload"){
													this.log('warn', 'Port '+ switchPort+' is not valid or does not support POE.');
												}
												else{
													this.log('error', 'ERROR: ' + err);
												}
											}
											this.controller.logout();
										}.bind(this));
									}
									else{
										this.log('warn', 'Device "'+mac+'" does not exist');
										this.controller.logout();
									}
								}
								else{
									this.log('warn', 'Device "'+mac+'" does not exist');
									this.controller.logout();
								}
							}
							else{
								this.log('warn', 'Device "'+mac+'" does not exist');
								this.controller.logout();
							}
						}
						else{
							this.log('warn', 'Device "'+mac+'" does not exist');
							this.controller.logout();
						}
					}
					else{
						this.log('warn', 'Device "'+mac+'" does not exist');
						this.controller.logout();
					}
				}
				else{
					this.log('warn', 'Device "'+mac+'" does not exist');
					this.controller.logout();
				}
			}.bind(this), mac);
		}.bind(this));
	}
}
exports = module.exports = instance;
