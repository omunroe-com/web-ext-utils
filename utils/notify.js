(function(global) { 'use strict'; define(({ // This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.
	'../browser/': { Notifications, isGecko, },
	require,
}) => {

/**
 * Displays a basic notification to the user.
 * @param  {string}   .title    Notification title.
 * @param  {string}   .message  Notification body text.
 * @param  {string}   .icon     Notification icon URL or one of [ 'default', 'info', 'warn', 'error', 'success', ]
 *                              to choose and/or generate an icon automatically.
 * @param  {natural?} .timeout  Timeout in ms after which to clear the notification.
 * @return {boolean}            Whether the notification was clicked or closed (incl. timeout).
 */
let notify = async function notify({ title, message, icon = 'default', timeout, }) { try {
	if (!Notifications) { console.info('notify', arguments[0]); return false; }
	const create = !open; open = true; const options = {
		type: 'basic', title, message,
		iconUrl: (/^\w+$/).test(icon) ? (await getIcon(icon)) : icon,
	}; !isGecko && (options.requireInteraction = true);
	try { (await Notifications[create || isGecko ? 'create' : 'update'](
		'web-ext-utils:notice', options,
	)); } catch (_) { open = false; throw _; }
	clearNotice(timeout == null ? -1 : typeof timeout === 'number' && timeout > 1e3 && timeout < 30 ** 2 ? timeout : 5000);
	onhide && onhide(); onclick = onhide = null;
	return new Promise(done => { onclick = () => done(true); onhide = () => done(false); });
} catch (_) { try {
	console.error(`failed to show notification`, arguments[0], _);
} catch (_) { } } return false; };

if (isGecko) { notify = throttle(notify, 300); } // what a great idea to rate-limit calls to Notify.create and NO implement Notify.update -.-

Object.assign(notify, {

	/**
	 * Uses a Notification to report a critical error to the user.
	 * Only displays a single message at once and hides that message after 7.5 seconds.
	 * Falls back to console.error if Notifications are unavailable.
	 * @param  {string?}    title     Optional. The Notification's title.
	 * @param  {...string}  messages  Additional message lines.
	 * @param  {Error?}     error     The error that was thrown.
	 * @return {boolean}              Whether the notification was clicked or closed (incl. timeout).
	 */
	async error(...messages) {
		try { console.error(...messages); } catch (_) { }
		const error = messages.pop();
		const title = (messages.shift() || `That didn't work ...`) +'';
		let message = messages.join('\n') + (messages.length ? '\n' : '');
		if (typeof error === 'string') {
			message += error;
		} else if (error) {
			if (error.name) { message += error.name +': '; }
			if (error.message) { message += error.message; }
		}
		if (!message && !error) { message = 'at all'; }

		return notify({ title, message, icon: 'error', timeout: 7500, });
	},

	/**
	 * Uses a Notification to report an operations success.
	 * Only displays a single message at once and hides that message after 5 seconds.
	 * @param  {string?}    title     Optional. The Notification's title.
	 * @param  {...string}  messages  Additional message lines.
	 * @return {boolean}              Whether the notification was clicked or closed (incl. timeout).
	 */
	async success(...messages) {
		const title = messages.shift() || `Operation completed successfully!`;
		const message = messages.join('\n');

		return notify({ title, message, icon: 'success', timeout: 5000, });
	},

	/// Displays a logging notification for up to 3 seconds. `title` is mandatory.
	async log(title, ...messages) {
		if (!title) { return false; } const message = messages.join('\n');
		return notify({ title, message, icon: 'default', timeout: 3000, });
	},

	/// Displays a informative notification for up to 3.5 seconds. `title` is mandatory.
	async info(title, ...messages) {
		if (!title) { return false; } const message = messages.join('\n');
		return notify({ title, message, icon: 'info', timeout: 3500, });
	},

	/// Displays a informative warning for up to 6 seconds. `title` is mandatory.
	async warn(title, ...messages) {
		if (!title) { return false; } const message = messages.join('\n');
		return notify({ title, message, icon: 'warn', timeout: 6000, });
	},
});

const clearNotice = debounce(() => {
	onhide && onhide(); onclick = onhide = null; open = false;
	Notifications.clear('web-ext-utils:notice');
});
Notifications.onClicked.addListener(id => {
	if (id !== 'web-ext-utils:notice') { return; }
	onclick && onclick(); clearNotice();
});
Notifications.onClosed.addListener(id => {
	if (id !== 'web-ext-utils:notice') { return; }
	onhide && onhide(); onclick = onhide = null; open = false;
	clearNotice(-1);
});
let open = false, onclick = null, onhide = null;

const icons = { }; let FS, iconUrl; async function getIcon(name) { try {
	if (icons[name]) { return icons[name]; }
	FS || (FS = (await require.async('./files')));
	const included = [ `${name}.svg`, `${name}.png`, `icons/${name}.svg`, `icons/${name}.png`, ].find(FS.exists);
	if (included) { return (icons[name] = require.toUrl(included)); }

	const ext = FS.exists('icon.svg') ? 'svg' : 'png', mime = 'image/'+ ext.replace('svg', 'svg+xml');
	!iconUrl && (iconUrl = `data:${mime};base64,`+ global.btoa(String.fromCharCode.apply(null, new Uint8Array(
		global.buffer = (await FS.readFile('icon.'+ ext))
	))));
	const svg = (await require.async(`fetch!./icons/${name}.svg`)).replace('{{iconUrl}}', iconUrl);
	return (icons[name] = global.URL.createObjectURL(new global.Blob([ svg, ], { type: 'image/svg+xml', })));
} catch (error) { console.error(error); return icons[name]; } }

function debounce(callback) { let timer = null; return function(time) {
	global.clearTimeout(timer); if (time == null) { callback(); return; } if (time < 0) { return; }
	timer = global.setTimeout(callback, time); // eslint-disable-line no-invalid-this
}; }

function throttle(callback, time) {
	let call = null, last = 0;
	return function(...args) {
		if (!call) {
			const wait = last + time - Date.now();
			setTimeout(() => {
				last = Date.now();
				call.done(callback(...call.args));
				call = null;
			}, wait > 0 ? wait : 0); // mustn't be << 0 in chrome 53+
		} else { call.done(false); }
		return new Promise(done => (call = { args, done, }));
	};
}

return notify;

}); })(this);
