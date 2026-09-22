'use strict';

// HH intent patterns for the standalone skill repo
// Only HH_DISCONNECT_INTENT is needed for hh-quick.test.js verification

const HH_DISCONNECT_INTENT   = /\/hh_disconnect|отключи(?:ть)?\s*(?:hh|хх|headhunter)|удали(?:ть)?\s*(?:hh|хх|headhunter)|hh.{0,15}(?:отключи|удали|разъедин|сброс)|сброс.{0,15}(?:hh|хх|headhunter|авторизац)|выключи.{0,15}(?:hh|хх|headhunter)|reset.{0,15}hh/i;

module.exports = {
  HH_DISCONNECT_INTENT,
};
