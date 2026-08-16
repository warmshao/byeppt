
import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { chatStrings } from './strings-chat'
import { paneStrings } from './strings-panes'
import { ribbonStrings } from './strings-ribbon'

export const strings = {
  zh: { ...appStrings.zh, ...ribbonStrings.zh, ...paneStrings.zh, ...chatStrings.zh, ...aiStrings.zh },
  en: { ...appStrings.en, ...ribbonStrings.en, ...paneStrings.en, ...chatStrings.en, ...aiStrings.en },
  ja: { ...appStrings.ja, ...ribbonStrings.ja, ...paneStrings.ja, ...chatStrings.ja, ...aiStrings.ja },
  ko: { ...appStrings.ko, ...ribbonStrings.ko, ...paneStrings.ko, ...chatStrings.ko, ...aiStrings.ko },
  fr: { ...appStrings.fr, ...ribbonStrings.fr, ...paneStrings.fr, ...chatStrings.fr, ...aiStrings.fr },
  de: { ...appStrings.de, ...ribbonStrings.de, ...paneStrings.de, ...chatStrings.de, ...aiStrings.de },
  es: { ...appStrings.es, ...ribbonStrings.es, ...paneStrings.es, ...chatStrings.es, ...aiStrings.es },
  th: { ...appStrings.th, ...ribbonStrings.th, ...paneStrings.th, ...chatStrings.th, ...aiStrings.th },
  id: { ...appStrings.id, ...ribbonStrings.id, ...paneStrings.id, ...chatStrings.id, ...aiStrings.id },
  ru: { ...appStrings.ru, ...ribbonStrings.ru, ...paneStrings.ru, ...chatStrings.ru, ...aiStrings.ru },
  ar: { ...appStrings.ar, ...ribbonStrings.ar, ...paneStrings.ar, ...chatStrings.ar, ...aiStrings.ar },
  pt: { ...appStrings.pt, ...ribbonStrings.pt, ...paneStrings.pt, ...chatStrings.pt, ...aiStrings.pt },
  it: { ...appStrings.it, ...ribbonStrings.it, ...paneStrings.it, ...chatStrings.it, ...aiStrings.it },
  pl: { ...appStrings.pl, ...ribbonStrings.pl, ...paneStrings.pl, ...chatStrings.pl, ...aiStrings.pl },
  nl: { ...appStrings.nl, ...ribbonStrings.nl, ...paneStrings.nl, ...chatStrings.nl, ...aiStrings.nl },
  ms: { ...appStrings.ms, ...ribbonStrings.ms, ...paneStrings.ms, ...chatStrings.ms, ...aiStrings.ms },
  he: { ...appStrings.he, ...ribbonStrings.he, ...paneStrings.he, ...chatStrings.he, ...aiStrings.he },
  hi: { ...appStrings.hi, ...ribbonStrings.hi, ...paneStrings.hi, ...chatStrings.hi, ...aiStrings.hi },
  'zh-TW': {
    ...appStrings['zh-TW'],
    ...ribbonStrings['zh-TW'],
    ...paneStrings['zh-TW'],
    ...chatStrings['zh-TW'],
    ...aiStrings['zh-TW'],
  },
}
