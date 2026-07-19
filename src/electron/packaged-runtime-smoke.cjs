'use strict';

const { CookieJar, JSDOM } = require('jsdom');
const WebSocket = require('ws');

const dom = new JSDOM('<main id="packaged-runtime-smoke">ok</main>', {
  cookieJar: new CookieJar(),
  url: 'https://packaged-runtime-smoke.invalid/',
});

if (dom.window.document.querySelector('#packaged-runtime-smoke')?.textContent !== 'ok') {
  throw new Error('Packaged jsdom runtime smoke check failed.');
}
dom.window.close();

if (typeof WebSocket !== 'function') {
  throw new Error('Packaged ws runtime export is unavailable.');
}

console.log('Packaged runtime verified: jsdom, tough-cookie, and ws are loadable.');
