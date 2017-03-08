(function(global) { 'use strict'; define(({ // This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.
	'../browser/': { runtime, extension, tabs, Tabs, Windows, Notifications, },
	Files,
	require,
}) => {

/// escapes a string for usage in a regular expression
const escape = string => string.replace(/[\-\[\]\{\}\(\)\*\+\?\.\,\\\^\$\|\#]/g, '\\$&');

/// matches all valid match patterns (except '<all_urls>') and extracts [ , scheme, host, path, ]
const matchPattern = (/^(?:(\*|http|https|file|ftp|app):\/\/(\*|(?:\*\.)?[^\/\*]+|)\/(.*))$/i);

/**
 * Transforms a valid match pattern into a regular expression which matches all URLs included by that pattern.
 * Passes all examples and counter-examples listed here https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Match_patterns#Examples
 * @param  {string}  pattern  The pattern to transform.
 * @return {RegExp}           The patterns equivalent as a RegExp.
 * @throws {TypeError}        If the pattern string is not a valid MatchPattern
 */
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

/**
 * Can be called during the extension startup to immediately attach all content scripts as they are specified in the 'manifest.json',
 * which does not happen automatically in chromium browsers. In firefox it is not necessary to call this function.
 * Supported keys for each content script are 'js', 'css', 'matches' and 'exclude_matches'. Globs are not supported.
 * Note: If this function is called during the browser startup, it may attach the content scripts to tabs that already have them running (usually just for the active tab, all others will not be visible yet).
 *       To avoid this (and to have a clean update when the extension is reloaded) your content scripts should set global destroy() functions that can be called by the options.cleanup function.
 * @param  {object}    options          Optional options object.
 * @param  {function}  options.cleanup  Optional function whose code is executed in each included tab before each content script to remove old versions of the script.
 * @return {Promise([ natural, ])}      Promise that resolves once the cleanup function ran in all included tabs. The numbers are the number of tabs each content script is applied to.
 *                                      Note, that the content scripts themselves have not necessarily been executed yet.
 */
async function attachAllContentScripts({ cleanup, } = { }) {
	if (typeof (cleanup = cleanup || (() => void 0)) !== 'function') { throw new TypeError('"Cleanup" parameter must be a function or falsey'); }
	const allTabs = (await Tabs.query({ }));
	const scripts = runtime.getManifest().content_scripts;

	return Promise.all(scripts.map(({ js, css, matches, exclude_matches, }) => {
		const includes = (matches || [ ]).map(matchPatternToRegExp);
		const excludes = (exclude_matches || [ ]).map(matchPatternToRegExp);
		return Promise.all(allTabs
			.filter(({ url, }) => url && includes.some(exp => exp.test(url)) && !excludes.some(exp => exp.test(url)))
			.map(async ({ id, }) => {
				try { (await Tabs.executeScript(id, { code: `(${ cleanup })();`, })); }
				catch (error) { console.warn('skipped tab', error); return false; } // not allowed to execute
				css && css.forEach(file => tabs.insertCSS(id, { file, }));
				js && js.forEach(file => tabs.executeScript(id, { file, }));
				return true;
			})
		).then(_=>_.filter(_=>_).length);
	}));
}

/**
 * Shows or opens a tab containing an extension page.
 * Shows the fist tab whose .pathname equals 'match' and that has a window.tabId set, or opens a new tab containing 'url' if no such tab is found.
 * To set a window.tabId, include ``(window.browser || window.chrome).tabs.getCurrent(tab => tab && (window.tabId = tab.id))`` in a script in the tabs that should be matchable.
 * @param  {string}        url    The url to open in the new tab if no existing tab was found.
 * @param  {string}        match  Optional value of window.location.pathname a existing tab must have to be focused.
 * @return {Promise<Tab>}         The chrome.tabs.Tab that is now the active tab in the focused window.
 */
async function showExtensionTab(url, match = url) {
	match = extension.getURL(match || url); url = extension.getURL(url);
	const window = extension.getViews({ type: 'tab', }).find(window =>
		window && (typeof match === 'string' ? window.location.href === match : match.test(window.location.href)) && window.tabId != null
	);
	const tab = (await (window ? Tabs.update(window.tabId, { active: true, }) : Tabs.create({ url, })));
	(await Windows.update(tab.windowId, { focused: true, }));
	return tab;
}

/**
 * Uses a Notification to report a critical error to the user.
 * Only displays a single message at once and hides that message after 5 seconds.
 * Falls back to console.error if Notifications are unavailable.
 * @param  {string?}  	title     Optional. The Notification's title.
 * @param  {...string}  messages  Additional message strings.
 * @param  {Error}      error     The error that was thrown.
 */
function reportError(...messages) { try {
	if (!Notifications) { return void console.error(...messages); }
	const error = messages.pop();
	const title = (messages.shift() || `That didn't work ...`) +'';
	let message = messages.join(' ') + (messages.length ? ' ' : '');
	if (typeof error === 'string') {
		message += error;
	} else {
		if (error && error.name) { message += error.name +': '; }
		if (error && error.message) { message += error.message; }
	}
	if (!message && !error) { message = 'at all'; }

	Notifications.create('web-ext-utils:error', {
		type: 'basic', title, message,
		iconUrl: require.toUrl([ 'error.svg', 'error.png', 'icon.svg', 'icon.png', ].find(Files.exists)),
	});
	clearErrorSoon();
} catch (_) { try { console.error(...messages); console.error(`failed to show notification`, _); } catch (_) { } } }
const clearErrorSoon = debounce(() => Notifications.clear('web-ext-utils:error'), 5000);

/**
 * Uses a Notification to report an operations success.
 * Only displays a single message at once and hides that message after 5 seconds.
 * @param  {string?}  	title     Optional. The Notification's title.
 * @param  {...string}  messages  Additional message strings.
 */
function reportSuccess(...messages) {
	if (!Notifications) { return void console.info(...messages); }
	const title = messages.shift() || `Operation completed successfully!`;
	const message = messages.join(' ');

	Notifications.create('web-ext-utils:success', {
		type: 'basic', title, message,
		iconUrl: require.toUrl([ 'success.svg', 'success.png', 'icon.svg', 'icon.png', ].find(Files.exists)),
	});
	clearSuccessSoon();
}
const clearSuccessSoon = debounce(() => Notifications.clear('web-ext-utils:success'), 5000);

function debounce(callback, time) {
	let timer = null;
	return function() {
		clearTimeout(timer);
		timer = setTimeout(() => callback.apply(this, arguments), time); // eslint-disable-line no-invalid-this
	};
}

return {
	matchPatternToRegExp,
	attachAllContentScripts,
	showExtensionTab,
	reportError,
	reportSuccess,
};

}); })(this);
