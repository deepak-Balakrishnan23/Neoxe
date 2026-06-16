import { contextBridge, ipcRenderer } from 'electron';
import { DesignFile, ChangeSet, IPCResponse } from '../shared/types';

const api = {
  newFile: (): Promise<IPCResponse<DesignFile>> =>
    ipcRenderer.invoke('file:new'),

  openFile: (): Promise<IPCResponse<DesignFile>> =>
    ipcRenderer.invoke('file:open'),

  saveFile: (): Promise<IPCResponse<void>> =>
    ipcRenderer.invoke('file:save'),

  loadFile: (file: DesignFile): Promise<IPCResponse<DesignFile>> =>
    ipcRenderer.invoke('file:load', file),

  getState: (): Promise<IPCResponse<DesignFile>> =>
    ipcRenderer.invoke('doc:getState'),

  applyChanges: (changeSet: ChangeSet): Promise<IPCResponse<DesignFile>> =>
    ipcRenderer.invoke('doc:applyChanges', changeSet),

  undo: (): Promise<IPCResponse<DesignFile>> =>
    ipcRenderer.invoke('doc:undo'),

  redo: (): Promise<IPCResponse<DesignFile>> =>
    ipcRenderer.invoke('doc:redo'),
};

contextBridge.exposeInMainWorld('designAPI', api);

// Native file save: open the OS save dialog and write to a chosen/known path.
const fileAPI = {
  saveDialog: (defaultName: string, filters?: { name: string; extensions: string[] }[]): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('dialog:save', defaultName, filters),
  writeFile: (filePath: string, content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('file:write', { filePath, content }),
  writeExport: (filePath: string, dataUrl: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('file:write-export', { filePath, dataUrl }),
};

contextBridge.exposeInMainWorld('fileAPI', fileAPI);

export type DesignAPI = typeof api;
export type FileAPI = typeof fileAPI;
