(function(global) { 'use strict'; const { currentScript, } = document; const factory = function Loader(exports) { // This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.
/* eslint-disable no-throw-literal */ /* eslint-disable prefer-promise-reject-errors */

/**
 * Dynamically executes functions as content scripts.
 * @param  {natural}       tabId    The id of the tab to run in.
 * @param  {natural}       frameId  Optional. The id of the frame within the tab to run in. Defaults to the top level frame.
 * @param  {function}      script   A function that will be decompiled and run as content script.
 * @param  {...any}        args     Arguments that will be cloned to call the function with.
 *                                  `this` in the function will be the global object (not necessarily `window`).
 * @return {any}                    The value returned or promised by `script`.
 * @throws {any}                    If `script` throws or otherwise fails to execute.
 */
async function runInTab(tabId, frameId, script, ...args) {
	if (typeof frameId !== 'number') { args.unshift(script); script = frameId; frameId = 0; }
	return Frame.get(tabId, frameId).request('run', getScource(script), args);
}

/**
 * Dynamically loads content scripts by `require()`ing them in the content context.
 * @param  {natural}          tabId    The id of the tab to run in.
 * @param  {natural}          frameId  Optional. The id of the frame within the tab to run in. Defaults to the top level frame.
 * @param  {[string]|object}  modules  An Array if module ids to load, or an object where each key is a module id
 *                                     and the values will be made available as `module.config()`.
 * @return {natural}                   The number of modules loaded.
 * @throws {any}                       If any of the modules throws or otherwise fails to load.
 */
async function requireInTab(tabId, frameId, modules) {
	if (typeof frameId !== 'number') { modules = frameId; frameId = 0; }
	return Frame.get(tabId, frameId).request('require', modules);
}

/**
 * Detaches all content scripts from the given context. Specifically, it performs the same steps as when the extension is unloaded.
 * That is, it fires the onUnload event, deletes the global define and require functions and closes the loader connection.
 * @param  {natural}   tabId    The id of the tab to run in.
 * @param  {natural}   frameId  Optional. The id of the frame within the tab to run in. Defaults to the top level frame.
 */
async function detachFormTab(tabId, frameId) {
	const frames = tabs.get(tabId);
	const frame = frames && frames.get(frameId);
	frame && frame.destroy();
}

/**
 * Defines a content script that can automatically attach to tabs.
 */
class ContentScript {
	/**
	 * @param  {object}  options  An object whose properties are assigned to the new instance.
	 *                            For the specific properties see below. Works as a copy constructor.
	 */
	constructor(options) {
		const self = {
			include: [ ], exclude: [ ], incognito: false, frames: 'top',
			modules: null, script: null, args: [ ],
			onMatch: new Event,
		}; Self.set(this, self);
		Object.assign(this, options);
	}

	/**
	 * The MatchPattern or RegExps matching urls to include.
	 * @param  {[string|RegExp]}  include  An array of regular expression objects or strings. RegExps are cloned and
	 *                                     strings starting with '^' and ending with '$' are interpreted as RegExp sources.
	 *                                     Everything else must be valid MatchPatterns. Either way they are case insensitive.
	 * @throws {TypeError}                 If the description above is not met.
	 * @return {[string]}                  The sources of the created RegExps.
	 */
	set include(v)   { Self.get(this).include = parsePatterns(v); listenToNavigation(); }
	get include()    { return Self.get(this).include.map(_=>_.source); }
	/**
	 * Same as .include, only that it can overrule includes to exclude them again.
	 */
	set exclude(v)   { Self.get(this).exclude = parsePatterns(v); }
	get exclude()    { return Self.get(this).exclude.map(_=>_.source); }
	/**
	 * Whether to include incognito tabs or not.
	 */
	set incognito(v) { Self.get(this).incognito = !!v; }
	get incognito()  { return Self.get(this).incognito; }
	/**
	 * The frames to run the ContentScript in.
	 * @param  {string}  frames  Enum:
	 *     'top'       Only execute in matching top level frames.
	 *     'matching'  Execute in all matching frames, regardless of the top level url.
	 */
	set frames(v)    { Self.get(this).frames = checkEnum([ 'top', 'matching', /*'children', 'all',*/ ], v); }
	get frames()     { return Self.get(this).frames; }
	/**
	 * The ids of the modules to load. Same as the modules parameter to requireInTab().
	 */
	set modules(v)   { if (typeof v !== 'object') { throw new Error(`'modules' must be an Array, object or null`); } Self.get(this).modules = v; }
	get modules()    { return Self.get(this).modules; }
	/**
	 * Function that is executed after all `.modules` specified in this ContentScript are loaded.
	 * @param  {function|null}  script  Same as the script parameter to runInTab().
	 * @return {string}                 The decompiled source of the function.
	 */
	set script(v)    { Self.get(this).script = v == null ? v : getScource(v); }
	get script()     { return Self.get(this).script; }
	/**
	 * Arguments to .script. Set as iterable, returned as Array.
	 */
	set args(v)      { Self.get(this).args = Array.from(v); }
	get args()       { return Self.get(this).args; }

	/**
	 * Applies the ContentScript to all already open tabs and frames it matches.
	 * @return {[object]}  An Array of { tabId, frameId, url, } describing all tabs this ContentScript was applied to.
	 */
	async applyNow() {
		const self = Self.get(this); const applied = new Set;
		const tabs = (await callChrome(chrome.tabs, 'query', { }));
		(await Promise.all(tabs.map(async ({ id: tabId, incognito, }) => Promise.all(
			(await callChrome(chrome.webNavigation, 'getAllFrames', { tabId, }))
			.map(async ({ frameId, url, }) => { try {
				const [ frame, , done, ] = (await Frame.get(tabId, frameId).applyIfMatches(self, url, incognito));
				(await done); applied.add(frame);
			} catch (error) { console.error(error); } })
		))));
		applied.delete(null); return applied;
	}

	/**
	 * Applies the ContentScript to a specific frame now, regardless of whether it matches.
	 */
	async applyToFrame(tabId, frameId = 0) {
		return Frame.get(tabId, frameId).applyIfMatches(Self.get(this), null);
	}

	get onMatch() {
		return Self.get(this).onMatch.event;
	}

	get onShow() {
		const self = Self.get(this);
		return (self.onShow || (self.onShow = new Event)).event;
	}

	get onHide() {
		const self = Self.get(this);
		return (self.onHide || (self.onHide = new Event)).event;
	}

	/**
	 * Permanently disables the instance so that it will never run any scripts again and all accessors will throw.
	 */
	destroy() {
		const self = Self.get(this);
		if (!self) { return; } Self.delete(this);
		self.onMatch.clear();
		self.include.length && listenToNavigation();
	}
}

//////// start of private implementation ////////

if (global.innerWidth || global.innerHeight) { // opened in tab
	global.location.href = '/view.html#403';
}

const chrome = (global.browser || global.chrome);
const rootUrl = chrome.extension.getURL('');
const gecko = rootUrl.startsWith('moz-');
const contentPath = new URL('./content.js', currentScript.src).href.replace(rootUrl, '/');
const requirePath = '/node_modules/es6lib/require.js';
const getScource = (() => { const { toString, } = (() => 0);
	return func => { if (typeof func !== 'function') { throw new Error(`'script' must be a function`); } return toString.call(func); };
})();
const callChrome = (api, method, ...args) => new Promise((y, n) => api[method](...args, value => n(chrome.runtime.lastError || y(value))));
let debug = false;

const tabs = new Map/*<tabId, Map<frameId, Frame>>*/;
const Self = new Map/*<ContentScript, object>*/;

function listenToNavigation() {
	if (!chrome.webNavigation) { return; }
	const filters = [ ];
	Self.forEach(self => filters.push(...self.include.map(exp => ({ urlMatches: exp.source, }))));
	chrome.webNavigation.onCommitted.removeListener(onNavigation); // must remove first to avoid duplicate
	if (!filters.length) { return; }
	chrome.webNavigation.onCommitted.addListener(onNavigation, { url: filters, });
}

function onNavigation({ tabId, frameId, url, }) {
	if (!(/^(?:https?|file|ftp|app):\/\//).test(url)) { return; } // i.e. '<all_urls>'
	const frame = Frame.get(tabId, frameId, true);
	Self.forEach(self => frame.applyIfMatches(self, url));
}

class Frame {
	constructor(tabId, frameId) {
		this.tabId = tabId;
		this.frameId = frameId;
		this.incognito = true;
		this.hidden = false;
		// this._parent = null;
		this.port = null;
		this.gettingPort = null;
		this.gotPort = null;
		this.inited = false;
		this.onhide = null;
		this.onshow = null;
		this.onremove = null;
		this.arg = null;
		this.scripts = new Set;
		this.destroy = this.destroy.bind(this);
	}

	static get(tabId, frameId, refresh) {
		let frames = tabs.get(tabId); if (!frames) { frames = new Map; tabs.set(tabId, frames); }
		refresh && frameId === 0 && frames.delete(frameId);
		let frame = frames.get(frameId); if (!frame) { frame = new Frame(tabId, frameId); frames.set(frameId, frame); }
		return frame;
	}

	async getPort() {
		let reject; this.gettingPort = new Promise((y, n) => ((this.gotPort = y), (reject = n)));
		callChrome(chrome.tabs, 'executeScript', this.tabId, {
			file: contentPath + (debug && gecko ? '?debug=true' : ''), frameId: this.frameId, matchAboutBlank: true, runAt: 'document_start',
		}).catch(reject);
		return this.gettingPort;
	}
	setPort(port) {
		this.port = port;
		port.frame = this;
		this.incognito = port.sender.tab.incognito;
		this.gotPort && this.gotPort();
		this.gotPort = null;
	}
	initContent() {
		if (requirePath) {
			chrome.tabs.executeScript(this.tabId, { file: requirePath, frameId: this.frameId, matchAboutBlank: true, runAt: 'document_start', });
		} else {
			this.post('ignoreRequire');
		}
	}

	async request(method, ...args) {
		if (!this.port) { (await (this.gettingPort || this.getPort())); }
		if (!this.inited) { this.inited = true; this.initContent(); }
		const id = Math.random() * 0x100000000000000;
		this.port.postMessage([ method, id, args, ]);
		return new Promise((resolve, reject) => this.port.requests.set(id, [ resolve, reject, ]));
	}
	async post(method, ...args) {
		if (!this.port) { (await (this.gettingPort || this.getPort())); }
		if (!this.inited) { this.inited = true; this.initContent(); }
		this.port.postMessage([ method, 0, args, ]);
	}

	async applyIfMatches(script, url = null, incognito = false) {
		if (url && (
			(script.frames === 'top' && this.frameId >= 1)
			|| incognito && !script.incognito
			|| !script.include.some(_=>_.test(url))
			|| script.exclude.some(_=>_.test(url))
		)) { return [ ]; }
		if (!this.port) { (await (this.gettingPort || this.getPort())); }
		if (url && this.incognito && !script.incognito) { return [ ]; }
		const done = (async () => {
			script.modules && (await this.request('require', script.modules));
			return script.script ? this.request('run', script.script, script.args) : undefined;
		})();
		url && script.onMatch.fire(this.eventArg, url, done);
		this.scripts.add(script);
		return [ this.eventArg, null, done, ];
	}

	hide() {
		if (this.hidden) { return; } this.hidden = true;
		this.onhide && this.onhide.fire(this.eventArg);
		this.scripts.forEach(script => script.onHide && script.onHide.fire(this.eventArg));
		const frames = tabs.get(this.tabId);
		this.frameId === 0 && frames.get(this.frameId) === this && frames.delete(this.frameId);
	}
	show() {
		if (!this.hidden) { return; } this.hidden = false;
		this.frameId === 0 && tabs.get(this.tabId).set(this.frameId, this.frame);
		this.onshow && this.onshow.fire(this.eventArg);
		this.scripts.forEach(script => script.onShow && script.onShow.fire(this.eventArg));
	}

	get onHide  () { if (!this.onhide)   { this.onhide   = new Event; } return this.onhide; }
	get onShow  () { if (!this.onshow)   { this.onshow   = new Event; } return this.onshow; }
	get onRemove() { if (!this.onremove) { this.onremove = new Event; } return this.onremove; }
	get eventArg() { const self = this; if (!this.arg) { this.arg = Object.freeze({
		tabId: this.tabId,
		frameId: this.frameId,
		incognito: this.incognito,
		get hidden() { return self.hidden; },
		get onPageHide() { return self.onPageHide.event; },
		get onPageShow() { return self.onPageShow.event; },
		get onRemove  () { return self.onRemove.event; },
	}); } return this.arg; }

	destroy(unload) {
		this.hide();
		const frames = tabs.get(this.tabId);
		frames && frames.get(this.frameId) === this && frames.delete(this.frameId);
		if (this.onremove) { !unload && this.onremove.fire(this.eventArg); this.onremove.listeners.clear(); this.onremove = null; }
		if (this.onhide) { this.onhide.listeners.clear(); this.onhide = null; }
		if (this.onshow) { this.onshow.listeners.clear(); this.onshow = null; }
		this.port && this.port.onDisconnect.removeListener(this.destroy);
		this.port && this.port.disconnect();
	}
}

function onConnect(port) {
	if (port.name !== 'require.scriptLoader') { return; }
	const { id: tabId, } = port.sender.tab;
	const { frameId, } = port.sender;
	port.requests = new Map/*<random, [ resolve, reject, ]>*/;
	port.onMessage.addListener(onMessage.bind(null, port));

	const frame = Frame.get(tabId, frameId);
	if (frame.port) { console.error(`Frame already has a port`, frame.port, frame); } // if onDisconnect gets fired correctly, this can't happen
	frame.setPort(port);
	port.onDisconnect.addListener(frame.destroy);
}

async function onMessage(port, [ method, id, args, ]) {
	if (method === '') { // handle responses
		const [ value, ] = args;
		const threw = id < 0; threw && (id = -id);
		const request = port.requests.get(id); port.requests.delete(id);
		request[+threw](value);
	} else { // handle requests
		if (!methods[method]) { port.postMessage([ '', -id, [ { message: 'Unknown request', }, ], ]); }
		else if (!id) {
			methods[method].apply(port, args);
		} else { try {
			const value = (await methods[method].apply(port, args));
			port.postMessage([ '', +id, [ value, ], ]);
		} catch (error) {
			error instanceof Error && (error = { name: error.name, message: error.message, stack: error.stack, });
			port.postMessage([ '', -id, [ error, ], ]);
		} }
	}
}

const methods = {
	loadScript(url) {
		if (!url.startsWith(rootUrl)) { throw { message: 'Can only load local resources', }; }
		const file = url.slice(rootUrl.length - 1);
		return new Promise((resolve, reject) => chrome.tabs.executeScript(this.sender.tab.id, {
			file, frameId: this.sender.frameId, matchAboutBlank: true, runAt: 'document_start',
		}, () => {
			if (!chrome.runtime.lastError) { resolve(true); }
			else { reject({ message: chrome.runtime.lastError.message, }); }
		}));
	},
	ping() {
		return true;
	},
	pagehide() {
		this.frame.hide();
	},
	pageshow() {
		this.frame.show();
	},
};

function parsePatterns(patterns) {
	!chrome.webNavigation && console.warn(`Using ContentScripts without "webNavigation"!`);
	!Array.isArray(patterns) && (patterns = [ patterns, ]);
	return patterns.map(pattern => {
		if (typeof pattern === 'object' && typeof pattern.test === 'function') { return new RegExp(pattern); }
		if (typeof pattern === 'string' && pattern[0] === '^' && pattern.slice(-1) === '$') { return new RegExp(pattern, 'i'); }
		try { return matchPatternToRegExp(pattern); }
		catch (_) { throw new TypeError(`Expected (Array of) RegExp objects, MatchPattern strings or regexp strings framed with '^' and '$', got "${ pattern }"`); }
	});
}

function checkEnum(choices, value) {
	if (value == null) { return choices[0]; }
	if (choices.includes(value)) { return value; }
	throw new Error(`This value must be one of: '`+ choices.join(`', `) +`'`);
}

function Event() {
	const listeners = new Set;
	return {
		listeners,
		fire() {
			listeners.forEach(listener => { try { listener.apply(null, arguments); } catch (error) { console.error(error); } });
		},
		event: {
			addListener(listener) { typeof listener === 'function' && listeners.add(listener); },
			hasListener(listener) { return listeners.has(listener); },
			removeListener(listener) { listeners.delete(listener); },
		},
	};
}

// copy from ../utils/index.js
const escape = string => string.replace(/[\-\[\]\{\}\(\)\*\+\?\.\,\\\^\$\|\#]/g, '\\$&');
const matchPattern = (/^(?:(\*|http|https|file|ftp|app):\/\/(\*|(?:\*\.)?[^\/\*]+|)\/(.*))$/i);
function matchPatternToRegExp(pattern) {
	if (pattern === '<all_urls>') { return (/^(?:https?|file|ftp|app):\/\//); } // TODO: this is from mdn, check if chrome behaves the same
	const match = matchPattern.exec(pattern);
	if (!match) { throw new TypeError(`"${ pattern }" is not a valid MatchPattern`); }
	const [ , scheme, host, path, ] = match;
	return new RegExp('^(?:'
		+ (scheme === '*' ? 'https?' : escape(scheme)) +':\/\/'
		+ (host === '*' ? '[^\/]+?' : escape(host).replace(/^\\\*\\./g, '(?:[^\/]+?.)?'))
		+ (path ? '\/'+ escape(path).replace(/\\\*/g, '.*') : '\/?')
	+')$');
}

window.addEventListener('unload', () => {
	tabs.forEach(_=>_.forEach(frame => Frame.prototype.destroy.call(frame, true)));
	tabs.clear();
});

{
	chrome.runtime.onConnect.addListener(onConnect);
}

Object.assign(exports, {
	ContentScript,
	runInTab,
	requireInTab,
	detachFormTab,
	parseMatchPatterns: parsePatterns,
});
Object.defineProperty(exports, 'debug', { set(v) { debug = !!v; }, get() { return debug; }, configurable: true, });

}; if (typeof define === 'function' && define.amd) { define([ 'exports', ], factory); } else { const exp = { }, result = factory(exp) || exp; global[factory.name] = result; } })(this);
