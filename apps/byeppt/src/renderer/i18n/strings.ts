
import { appStrings } from './strings-app'
import { paneStrings } from './strings-panes'
import { ribbonStrings } from './strings-ribbon'

export const strings = {
  zh: { ...appStrings.zh, ...ribbonStrings.zh, ...paneStrings.zh },
  en: { ...appStrings.en, ...ribbonStrings.en, ...paneStrings.en },
  ja: { ...appStrings.ja, ...ribbonStrings.ja, ...paneStrings.ja },
  ko: { ...appStrings.ko, ...ribbonStrings.ko, ...paneStrings.ko },
  fr: { ...appStrings.fr, ...ribbonStrings.fr, ...paneStrings.fr },
  de: { ...appStrings.de, ...ribbonStrings.de, ...paneStrings.de },
  es: { ...appStrings.es, ...ribbonStrings.es, ...paneStrings.es },
  th: { ...appStrings.th, ...ribbonStrings.th, ...paneStrings.th },
  id: { ...appStrings.id, ...ribbonStrings.id, ...paneStrings.id },
  ru: { ...appStrings.ru, ...ribbonStrings.ru, ...paneStrings.ru },
  ar: { ...appStrings.ar, ...ribbonStrings.ar, ...paneStrings.ar },
  pt: { ...appStrings.pt, ...ribbonStrings.pt, ...paneStrings.pt },
  it: { ...appStrings.it, ...ribbonStrings.it, ...paneStrings.it },
  pl: { ...appStrings.pl, ...ribbonStrings.pl, ...paneStrings.pl },
  nl: { ...appStrings.nl, ...ribbonStrings.nl, ...paneStrings.nl },
  ms: { ...appStrings.ms, ...ribbonStrings.ms, ...paneStrings.ms },
  he: { ...appStrings.he, ...ribbonStrings.he, ...paneStrings.he },
  hi: { ...appStrings.hi, ...ribbonStrings.hi, ...paneStrings.hi },
  'zh-TW': {
    ...appStrings['zh-TW'],
    ...ribbonStrings['zh-TW'],
    ...paneStrings['zh-TW'],
  },
}
