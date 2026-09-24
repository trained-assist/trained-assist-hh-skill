'use strict';
// Loaded in every Node child/worker by the isolated runner. Nock 14 also guards fetch.
const nock = require('nock');
nock.disableNetConnect();
nock.enableNetConnect(host => /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host));
