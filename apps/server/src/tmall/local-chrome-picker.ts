import { fileURLToPath } from "node:url";
import {
  WindowsLocalXlsxPicker,
  type LocalXlsxPicker,
  type LocalXlsxPickerResult,
  type WindowsLocalXlsxPickerOptions,
} from "../manual-products/local-xlsx-picker";

export type LocalChromePickerResult = LocalXlsxPickerResult;
export type LocalChromePicker = LocalXlsxPicker;
export type WindowsLocalChromePickerOptions = WindowsLocalXlsxPickerOptions;

export class WindowsLocalChromePicker extends WindowsLocalXlsxPicker {
  constructor(options: WindowsLocalChromePickerOptions = {}) {
    super({
      ...options,
      helperPath: options.helperPath
        ?? fileURLToPath(new URL("../../resources/select-local-chrome.ps1", import.meta.url)),
    });
  }
}
