'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('agentBar', {
  discover: () => ipcRenderer.invoke('agents:discover'),
  refresh: () => ipcRenderer.invoke('agents:refresh'),
  run: (payload) => ipcRenderer.invoke('agent:run', payload),
  cancel: (executionId) => ipcRenderer.invoke('run:cancel', executionId),

  history: {
    list: () => ipcRenderer.invoke('history:list'),
    read: (sessionID) => ipcRenderer.invoke('history:read', sessionID),
    export: (sessionID) => ipcRenderer.invoke('history:export', sessionID),
    copy: (sessionID) => ipcRenderer.invoke('history:copy', sessionID),
    remove: (sessionID) => ipcRenderer.invoke('history:delete', sessionID),
  },

  files: {
    open: (target) => ipcRenderer.invoke('file:open', target),
  },

  permissions: {
    reply: (payload) => ipcRenderer.invoke('permission:reply', payload),
  },

  meeting: {
    start: (payload) => ipcRenderer.invoke('meeting:start', payload),
    state: () => ipcRenderer.invoke('meeting:state'),
    pause: () => ipcRenderer.invoke('meeting:pause'),
    resume: () => ipcRenderer.invoke('meeting:resume'),
    skip: () => ipcRenderer.invoke('meeting:skip'),
    moderator: (text) => ipcRenderer.invoke('meeting:moderator', text),
    add: (name) => ipcRenderer.invoke('meeting:add', name),
    remove: (name) => ipcRenderer.invoke('meeting:remove', name),
    stop: () => ipcRenderer.invoke('meeting:stop'),
    templates: () => ipcRenderer.invoke('meeting:templates'),
    saveTemplate: (payload) => ipcRenderer.invoke('meeting:save-template', payload),
    deleteTemplate: (id) => ipcRenderer.invoke('meeting:delete-template', id),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
  },

  kiro: {
    state: () => ipcRenderer.invoke('kiro:state'),
    onUpdated: (callback) => subscribe('kiro:updated', callback),
    onNotice: (callback) => subscribe('kiro:notice', callback),
  },

  steering: {
    get: (id) => ipcRenderer.invoke('steering:get', id),
    save: (payload) => ipcRenderer.invoke('steering:save', payload),
    remove: (id) => ipcRenderer.invoke('steering:delete', id),
    preview: (payload) => ipcRenderer.invoke('steering:preview', payload),
    generate: (payload) => ipcRenderer.invoke('steering:generate', payload),
  },

  specs: {
    read: (name) => ipcRenderer.invoke('specs:read', name),
    create: (payload) => ipcRenderer.invoke('specs:create', payload),
    setAgent: (payload) => ipcRenderer.invoke('specs:set-agent', payload),
    approve: (payload) => ipcRenderer.invoke('specs:approve', payload),
    generate: (payload) => ipcRenderer.invoke('specs:generate', payload),
    setTaskStatus: (payload) => ipcRenderer.invoke('specs:task-status', payload),
    runTask: (payload) => ipcRenderer.invoke('specs:run-task', payload),
    runAll: (payload) => ipcRenderer.invoke('specs:run-all', payload),
    stop: (name) => ipcRenderer.invoke('specs:stop', name),
    remove: (name) => ipcRenderer.invoke('specs:delete', name),
  },

  hooks: {
    save: (payload) => ipcRenderer.invoke('hooks:save', payload),
    remove: (id) => ipcRenderer.invoke('hooks:delete', id),
    toggle: (payload) => ipcRenderer.invoke('hooks:toggle', payload),
    authorize: (id) => ipcRenderer.invoke('hooks:authorize', id),
    run: (id) => ipcRenderer.invoke('hooks:run', id),
  },

  onAgentsUpdated: (callback) => subscribe('agents:updated', callback),
  onRunEvent: (callback) => subscribe('run:event', callback),
  onActivityEvent: (callback) => subscribe('activity:event', callback),
  onLiveUpdate: (callback) => subscribe('live:update', callback),
  onServerStatus: (callback) => subscribe('server:status', callback),
  onHistoryUpdated: (callback) => subscribe('history:updated', callback),
  onPermissionAsked: (callback) => subscribe('permission:asked', callback),
  onPermissionReplied: (callback) => subscribe('permission:replied', callback),
  onMeetingEvent: (callback) => subscribe('meeting:event', callback),
});
