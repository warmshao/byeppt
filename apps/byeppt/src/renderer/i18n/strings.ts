
import { appStrings } from './strings-app'
import { chatStrings } from './strings-chat'
import { paneStrings } from './strings-panes'
import { ribbonStrings } from './strings-ribbon'

export const strings = {
  zh: { ...appStrings.zh, ...ribbonStrings.zh, ...paneStrings.zh, ...chatStrings.zh },
  en: { ...appStrings.en, ...ribbonStrings.en, ...paneStrings.en, ...chatStrings.en },
  ja: { ...appStrings.ja, ...ribbonStrings.ja, ...paneStrings.ja, ...chatStrings.ja },
  ko: { ...appStrings.ko, ...ribbonStrings.ko, ...paneStrings.ko, ...chatStrings.ko },
  fr: { ...appStrings.fr, ...ribbonStrings.fr, ...paneStrings.fr, ...chatStrings.fr },
  de: { ...appStrings.de, ...ribbonStrings.de, ...paneStrings.de, ...chatStrings.de },
  es: { ...appStrings.es, ...ribbonStrings.es, ...paneStrings.es, ...chatStrings.es },
  th: { ...appStrings.th, ...ribbonStrings.th, ...paneStrings.th, ...chatStrings.th },
  id: { ...appStrings.id, ...ribbonStrings.id, ...paneStrings.id, ...chatStrings.id },
  ru: { ...appStrings.ru, ...ribbonStrings.ru, ...paneStrings.ru, ...chatStrings.ru },
  ar: { ...appStrings.ar, ...ribbonStrings.ar, ...paneStrings.ar, ...chatStrings.ar },
  pt: { ...appStrings.pt, ...ribbonStrings.pt, ...paneStrings.pt, ...chatStrings.pt },
  it: { ...appStrings.it, ...ribbonStrings.it, ...paneStrings.it, ...chatStrings.it },
  pl: { ...appStrings.pl, ...ribbonStrings.pl, ...paneStrings.pl, ...chatStrings.pl },
  nl: { ...appStrings.nl, ...ribbonStrings.nl, ...paneStrings.nl, ...chatStrings.nl },
  ms: { ...appStrings.ms, ...ribbonStrings.ms, ...paneStrings.ms, ...chatStrings.ms },
  he: { ...appStrings.he, ...ribbonStrings.he, ...paneStrings.he, ...chatStrings.he },
  hi: { ...appStrings.hi, ...ribbonStrings.hi, ...paneStrings.hi, ...chatStrings.hi },
  'zh-TW': {
    ...appStrings['zh-TW'],
    ...ribbonStrings['zh-TW'],
    ...paneStrings['zh-TW'],
    ...chatStrings['zh-TW'],
  },
}
