'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Open a native folder-picker dialog. Returns the selected path, or null. */
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  /** List a directory. Returns [{name: string, isDirectory: boolean}] */
  readdir: (folderPath) => ipcRenderer.invoke('fs:readdir', folderPath),

  /** Read a text file (UTF-8). Returns the file contents as a string. */
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),

  /** Check if a path exists on disk. Returns boolean. */
  exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),

  /** Try to auto-detect a SORA_EXPORT folder. Returns path string or null. */
  autoDetect: () => ipcRenderer.invoke('fs:autoDetect'),

  /**
   * Join path segments using Node's path.join.
   * The renderer cannot use path.join directly (no Node access), so we expose it here.
   */
  joinPath: (...parts) => path.join(...parts)
});
