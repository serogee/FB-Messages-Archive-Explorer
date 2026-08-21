import { bench, describe } from 'vitest';
import { parseMessengerJsonContent } from '../../src/services/parser';
import { parseMessengerExportJson } from '../../src/services/messengerExport/messengerExportParser';
import {
  generateFacebookThreadJson,
  generateMessengerExportJson,
} from './generatedData';

const facebook10k = generateFacebookThreadJson(10_000);
const messenger10k = generateMessengerExportJson(10_000);
const benchOptions = { time: 500, warmupTime: 100 };

describe('parser performance', () => {
  bench('parse Facebook archive JSON with 10k messages', () => {
    parseMessengerJsonContent(facebook10k);
  }, benchOptions);

  bench('parse Messenger export JSON with 10k messages', () => {
    parseMessengerExportJson(messenger10k);
  }, benchOptions);
});
