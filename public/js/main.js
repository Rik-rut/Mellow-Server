// Provide safe fallback for non-browser / Node testing environments
if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
  const _noop = () => {};
  const _mockEl = () => ({
    style: {},
    classList: { add: _noop, remove: _noop, toggle: _noop, contains: () => false },
    addEventListener: _noop,
    removeEventListener: _noop,
    querySelector: () => _mockEl(),
    querySelectorAll: () => [],
    appendChild: _noop,
    prepend: _noop,
    remove: _noop,
    focus: _noop,
    select: _noop,
    setAttribute: _noop,
    getAttribute: () => null,
    removeAttribute: _noop,
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    click: _noop
  });
  globalThis.window = globalThis.window || {
    addEventListener: _noop,
    removeEventListener: _noop,
    localStorage: { getItem: () => null, setItem: _noop, removeItem: _noop, clear: _noop },
    location: { reload: _noop, href: '' }
  };
  globalThis.document = globalThis.document || {
    getElementById: () => _mockEl(),
    querySelector: () => _mockEl(),
    querySelectorAll: () => [],
    createElement: () => _mockEl(),
    addEventListener: _noop,
    removeEventListener: _noop,
    body: _mockEl(),
    activeElement: null
  };
  globalThis.localStorage = globalThis.localStorage || globalThis.window.localStorage;
  globalThis.navigator = globalThis.navigator || { mediaDevices: {} };
  globalThis.Audio = globalThis.Audio || class { play() { return Promise.resolve(); } pause() {} };
  globalThis.TextFormat = globalThis.TextFormat || {
    escapeHtml: (s) => String(s || ''),
    escapeRegex: (s) => String(s || ''),
    tokenizeMessage: () => [],
    formatMarkdown: (s) => String(s || '')
  };
}

let ws;
let token = (typeof localStorage !== 'undefined' && localStorage.getItem) ? localStorage.getItem('token') : null;
let currentUser = null;
let currentChannelId = null;
let channels = [];
let archivedDmIds = [];

function loadArchivedDms() {
  try {
    const raw = (typeof localStorage !== 'undefined' && localStorage.getItem) ? localStorage.getItem('mellow_archived_dms') : null;
    archivedDmIds = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(archivedDmIds)) archivedDmIds = [];
  } catch (_) {
    archivedDmIds = [];
  }
}

function saveArchivedDms() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.setItem) {
      localStorage.setItem('mellow_archived_dms', JSON.stringify(archivedDmIds));
    }
  } catch (_) {}
}

loadArchivedDms();

function archiveDmConversation(channelId) {
  if (!channelId) return;
  if (!archivedDmIds.includes(channelId)) {
    archivedDmIds.push(channelId);
    saveArchivedDms();
  }
  if (currentChannelId === channelId) {
    showDmHomeView();
  }
  renderDMs();
}

function unarchiveDmConversation(channelId) {
  if (!channelId) return;
  if (archivedDmIds.includes(channelId)) {
    archivedDmIds = archivedDmIds.filter(id => id !== channelId);
    saveArchivedDms();
    renderDMs();
  }
}

async function deleteDmConversation(channelId) {
  if (!channelId) return;
  const confirmed = await showConfirmModal({
    title: 'Delete Conversation',
    message: 'Are you sure you want to permanently delete this DM conversation? This action cannot be undone.',
    confirmText: 'Delete',
    danger: true
  });
  if (confirmed) {
    sendWS('dm:delete', { channelId });
  }
}
let servers = [];
let currentServerId = 'default-server';
let collapsedCategories = new Set();
let targetCategoryIdForNewChannel = null;
let selectedFiles = [];
let wsAuthenticated = false;
let currentMessages = [];
let activeReply = null;
let editingMessageId = null;
let voiceDeafened = false;
let userVolumes = {};
try {
  userVolumes = JSON.parse(localStorage.getItem('user_volumes') || '{}');
} catch (e) {
  userVolumes = {};
}

/* ── Sound System ─────────────────────────────────────────────────────────── */
const SOUNDS = {
  chat: '/aud/notification.wav',
  notification: '/aud/notification.wav',
  mention: '/aud/notification.wav',
  joined: '/aud/joined.wav',
  leave: '/aud/leave.wav',
  call: '/aud/call.wav'
};
let soundCtx = null;
const soundBuffers = {};
let soundInitialized = false;
let soundInitAttempts = 0;
const MAX_SOUND_INIT_ATTEMPTS = 3;
const DEFAULT_SFX_VOLUME = 0.45;
let ringtoneAudio = null;

function getNotificationSetting() {
  return localStorage.getItem('notification_setting') || 'all';
}

function setNotificationSetting(setting) {
  if (['all', 'mentions', 'mute'].includes(setting)) {
    localStorage.setItem('notification_setting', setting);
  }
}

/* Desktop-client native notifications (Mellow Tauri client only; in a plain
   browser this is a no-op and behavior is unchanged). */
function notifyDesktop(title, body) {
  try {
    const T = window.__TAURI__;
    if (T && T.core && T.core.invoke) {
      T.core.invoke('desktop_notify', { title, body }).catch(() => {});
    }
  } catch (_) {}
}

function notifyDesktopFor(data, isDM) {
  if (currentUser && currentUser.status === 'dnd') return;
  const setting = getNotificationSetting();
  if (setting === 'mute') return;
  if (setting === 'mentions' && !isDM) return;
  if (document.hasFocus() && !document.hidden) return;
  const sender = allUsersData.find(u => u.id === data.senderId);
  notifyDesktop(
    sender ? `${sender.username} • ${isDM ? 'Direct Message' : 'Mellow'}` : 'New message on Mellow',
    isDM ? 'Sent you a direct message' : 'New message in a channel'
  );
}

function startRingtone() {
  if (currentUser && (currentUser.status === 'dnd' || currentUser.status === "dnd" || getNotificationSetting() === 'mute')) {
    return;
  }
  stopRingtone();
  try {
    ringtoneAudio = new Audio(SOUNDS.call);
    ringtoneAudio.loop = true;
    ringtoneAudio.volume = DEFAULT_SFX_VOLUME;
    if (selectedAudioOutputId && typeof ringtoneAudio.setSinkId === 'function') {
      ringtoneAudio.setSinkId(selectedAudioOutputId).catch(() => {});
    }
    ringtoneAudio.play().catch(e => console.warn('Ringtone autoplay prevented:', e));
  } catch (e) {
    console.warn('Error starting ringtone:', e);
  }
}

function stopRingtone() {
  if (ringtoneAudio) {
    try {
      ringtoneAudio.pause();
      ringtoneAudio.currentTime = 0;
    } catch (e) {}
    ringtoneAudio = null;
  }
}

async function initSounds() {
  if (soundInitialized) return true;
  if (soundInitAttempts >= MAX_SOUND_INIT_ATTEMPTS) {
    console.warn('Sound initialization failed after multiple attempts');
    return false;
  }

  try {
    soundInitAttempts++;

    if (!soundCtx) {
      soundCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (selectedAudioOutputId && typeof soundCtx.setSinkId === 'function') {
      soundCtx.setSinkId(selectedAudioOutputId).catch(() => {});
    }

    // Resume context if suspended
    if (soundCtx.state === 'suspended') {
      await soundCtx.resume();
    }

    // Pre-fetch and decode all sounds in parallel
    const results = await Promise.all(Object.entries(SOUNDS).map(async ([name, url]) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${url}`);
        }
        const buf = await response.arrayBuffer();
        const decoded = await soundCtx.decodeAudioData(buf);
        soundBuffers[name] = decoded;
        return { name, success: true };
      } catch (e) {
        console.warn('Sound load failed:', name, e);
        return { name, success: false };
      }
    }));

    const allLoaded = results.every(r => r.success);
    if (allLoaded) {
      soundInitialized = true;
      return true;
    } else {
      // Some sounds failed, try again if not max attempts
      if (soundInitAttempts < MAX_SOUND_INIT_ATTEMPTS) {
        setTimeout(() => initSounds(), 1000);
      }
      return false;
    }
  } catch (e) {
    console.warn('Audio context init failed:', e);
    if (soundInitAttempts < MAX_SOUND_INIT_ATTEMPTS) {
      setTimeout(() => initSounds(), 1000);
    }
    return false;
  }
}

function playSound(name) {
  // If user has Do Not Disturb enabled, silence chat and mention notifications
  if (currentUser && (currentUser.status === 'dnd' || currentUser.status === "dnd") && (name === 'chat' || name === 'mention' || name === 'notification')) {
    return;
  }

  // If notifications are muted, silence chat, mention, and notification sounds
  if (getNotificationSetting() === 'mute' && (name === 'chat' || name === 'mention' || name === 'notification')) {
    return;
  }

  if (!soundInitialized || !soundCtx || !soundBuffers[name]) {
    // Try to initialize again if not yet successful
    if (!soundInitialized && soundInitAttempts < MAX_SOUND_INIT_ATTEMPTS) {
      initSounds();
    }
    return;
  }

  try {
    // Ensure context is running (some browsers suspend it again after a while)
    if (soundCtx.state === 'suspended') {
      soundCtx.resume().catch(e => console.warn('Could not resume audio context:', e));
    }

    // Create a new source for each play
    const src = soundCtx.createBufferSource();
    src.buffer = soundBuffers[name];
    
    // Master gain staging to eliminate loud peaks and ear fatigue
    const gainNode = soundCtx.createGain();
    gainNode.gain.setValueAtTime(DEFAULT_SFX_VOLUME, soundCtx.currentTime);
    src.connect(gainNode);
    gainNode.connect(soundCtx.destination);

    src.start(0);
  } catch (e) {
    console.warn('Could not play sound:', name, e);
  }
}

// More robust sound initialization trigger
function triggerSoundInit() {
  if (!soundInitialized) {
    initSounds().then(success => {
      if (!success) {
        // Keep trying on user interactions
        setTimeout(triggerSoundInit, 2000);
      }
    });
  }
}
/* ───────────────────────────────────────────────────────────────────────── */

const authScreen = document.getElementById('auth-screen');
const app = document.getElementById('app');
const authForm = document.getElementById('auth-form');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');
const authError = document.getElementById('auth-error');
const authSubmit = document.getElementById('auth-submit');
const authTabs = document.querySelectorAll('.auth-tab');
const channelList = document.getElementById('channel-list');
const dmList = document.getElementById('dm-list');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const fileBtn = document.getElementById('file-btn');
const fileInput = document.getElementById('file-input');
const fileChips = document.getElementById('file-chips');
const currentChannelName = document.getElementById('current-channel-name');
const userList = document.getElementById('user-list');
const onlineCount = document.getElementById('online-count');
const offlineUserList = document.getElementById('offline-user-list');
const offlineCount = document.getElementById('offline-count');
const userName = document.getElementById('user-name');
const userRoleBadge = document.getElementById('user-role-badge');
const userAvatar = document.getElementById('user-avatar');
const settingsBtn = document.getElementById('sidebar-settings-btn') || document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const profilePicInput = document.getElementById('profile-pic-input');
const uploadPicBtn = document.getElementById('upload-pic-btn');
const adjustPicBtn = document.getElementById('adjust-pic-btn');
const settingsProfilePic = document.getElementById('settings-profile-pic');
const avatarCropModal = document.getElementById('avatar-crop-modal');
const avatarCropCloseBtn = document.getElementById('avatar-crop-close');
const avatarCropViewport = document.getElementById('avatar-crop-viewport');
const avatarCropImg = document.getElementById('avatar-crop-img');
const avatarCropZoom = document.getElementById('avatar-crop-zoom');
const cropZoomInBtn = document.getElementById('crop-zoom-in');
const cropZoomOutBtn = document.getElementById('crop-zoom-out');
const avatarCropResetBtn = document.getElementById('avatar-crop-reset');
const avatarCropCancelBtn = document.getElementById('avatar-crop-cancel');
const avatarCropSaveBtn = document.getElementById('avatar-crop-save');
const addChannelBtn = document.getElementById('add-channel-btn');
const channelModal = document.getElementById('channel-modal');
const channelNameInput = document.getElementById('channel-name-input');
const createChannelBtn = document.getElementById('create-channel-btn');
const channelError = document.getElementById('channel-error');
const createChannelPrivateToggle = document.getElementById('create-channel-private-toggle');
const createChannelMembersWrap = document.getElementById('create-channel-members-wrap');
const createChannelMembersList = document.getElementById('create-channel-members-list');
const createChannelMembersContainer = document.getElementById('create-channel-members-container');

const channelSettingsModal = document.getElementById('channel-settings-modal');
const channelSettingsTitle = document.getElementById('channel-settings-title');
const channelSettingsCloseBtn = document.getElementById('channel-settings-close-btn');
const channelSettingsNameInput = document.getElementById('channel-settings-name-input');
const channelSettingsPrivateToggle = document.getElementById('channel-settings-private-toggle');
const channelSettingsMembersSection = document.getElementById('channel-settings-members-section');
const channelSettingsMembersList = document.getElementById('channel-settings-members-list');
const channelSettingsError = document.getElementById('channel-settings-error');
const channelSettingsCancelBtn = document.getElementById('channel-settings-cancel-btn');
const channelSettingsSaveBtn = document.getElementById('channel-settings-save-btn');

const voiceView = document.getElementById('voice-view');
const voiceActiveView = document.getElementById('voice-active-view');
const voiceParticipantsEl = document.getElementById('voice-participants');
const voiceJoinBtn = document.getElementById('voice-join-btn');
const voiceMuteBtn = document.getElementById('voice-mute-btn');
const voiceScreenBtn = document.getElementById('voice-screen-btn');
const voiceLeaveBtn = document.getElementById('voice-leave-btn');
const voiceControls = document.getElementById('voice-controls');
const voiceSettingsBtn = document.getElementById('voice-settings-btn');
const voiceStatusSettingsBtn = document.getElementById('voice-status-settings-btn');
const voiceSettingsModal = document.getElementById('voice-settings-modal');
const voiceSettingsCloseBtn = document.getElementById('voice-settings-close');

let selectedAudioInputId = (typeof localStorage !== 'undefined' && localStorage.getItem) ? (localStorage.getItem('mellow_audio_input_id') || '') : '';
let selectedAudioOutputId = (typeof localStorage !== 'undefined' && localStorage.getItem) ? (localStorage.getItem('mellow_audio_output_id') || '') : '';

let micTestStream = null;
let micTestAudioCtx = null;
let micTestChain = null;
let micTestAnalyser = null;
let micTestAnimFrame = null;
let isTestingMic = false;
const voiceScreenArea = document.getElementById('voice-screen-area');
const voiceScreenContainer = document.getElementById('voice-screen-container');
const voiceScreenStopBtn = document.getElementById('voice-screen-stop-btn');
const voiceScreenLabel = document.getElementById('voice-screen-label');
const messageInputArea = document.getElementById('message-input-area');
const chatArea = document.getElementById('chat-area');
const voiceChatCloseBtn = document.getElementById('voice-chat-close-btn');
const imageViewer = document.getElementById('image-viewer');
const imageViewerImg = document.getElementById('image-viewer-img');
const imageViewerCloseBtn = document.getElementById('image-viewer-close');

// Mellow Navigation Rail & Adaptive Sidebar
const railDmBtn = document.getElementById('rail-dm-btn');
const railServerBtn = document.getElementById('rail-server-btn');
const railServersList = document.getElementById('rail-servers-list');
const railAddBtn = document.getElementById('rail-add-btn');
const railSwitcherBtn = document.getElementById('rail-switcher-btn');
const sidebarChannelsView = document.getElementById('sidebar-channels-view');
const sidebarDmsView = document.getElementById('sidebar-dms-view');
const serverNameLabel = document.getElementById('server-name-label');
const serverHeaderDropdownTrigger = document.getElementById('server-header-dropdown-trigger');
const serverDropdownBtn = document.getElementById('server-dropdown-btn');
const serverDropdownMenu = document.getElementById('server-dropdown-menu');
const serverMenuAddChannel = document.getElementById('server-menu-add-channel');
const serverMenuAddCategory = document.getElementById('server-menu-add-category');
const serverMenuMembers = document.getElementById('server-menu-members');
const serverMenuSettings = document.getElementById('server-menu-settings');
const serverMenuDelete = document.getElementById('server-menu-delete');
const createServerModal = document.getElementById('create-server-modal');
const createServerName = document.getElementById('create-server-name');
const createServerError = document.getElementById('create-server-error');
const submitCreateServerBtn = document.getElementById('submit-create-server-btn');
const createServerIconPreview = document.getElementById('create-server-icon-preview');
const createServerIconFile = document.getElementById('create-server-icon-file');
const createServerUploadBtn = document.getElementById('create-server-upload-btn');
let createServerSelectedIcon = '/img/server-icons/icon-1.svg';

const serverSettingsModal = document.getElementById('server-settings-modal');
const editServerName = document.getElementById('edit-server-name');
const editServerError = document.getElementById('edit-server-error');
const editServerIconPreview = document.getElementById('edit-server-icon-preview');
const editServerIconFile = document.getElementById('edit-server-icon-file');
const editServerUploadBtn = document.getElementById('edit-server-upload-btn');
const saveServerSettingsBtn = document.getElementById('save-server-settings-btn');
const deleteServerBtn = document.getElementById('delete-server-btn');
let editServerSelectedIcon = '';
const createCategoryModal = document.getElementById('create-category-modal');
const createCategoryName = document.getElementById('create-category-name');
const createCategoryError = document.getElementById('create-category-error');
const submitCreateCategoryBtn = document.getElementById('submit-create-category-btn');
const serverMembersModal = document.getElementById('server-members-modal');
const serverMembersList = document.getElementById('server-members-list');
const serverMembersModalTitle = document.getElementById('server-members-modal-title');
const channelMembersView = document.getElementById('channel-members-view');
const dmProfileCard = document.getElementById('dm-profile-card');
const dmProfileAvatar = document.getElementById('dm-profile-avatar');
const dmProfileStatusDot = document.getElementById('dm-profile-status-dot');
const dmProfileName = document.getElementById('dm-profile-name');
const dmProfileTag = document.getElementById('dm-profile-tag');
const dmProfileStatusText = document.getElementById('dm-profile-status-text');
const dmProfileCallBtn = document.getElementById('dm-profile-call-btn');
const dmProfileBioText = document.getElementById('dm-profile-bio-text');
const dmFilterInput = document.getElementById('dm-filter-input');
const dmLogoutBtn = document.getElementById('dm-logout-btn');

const dmBackBtn = document.getElementById('dm-back-btn');
const dmHomeView = document.getElementById('dm-home-view');
const dmHomeHeaderTabs = document.getElementById('dm-home-header-tabs');
const dmHomeSearchInput = document.getElementById('dm-home-search-input');
const dmHomeMembersList = document.getElementById('dm-home-members-list');
const dmHomeSectionTitle = document.getElementById('dm-home-section-title');
const serverAddMembersSidebarBtn = document.getElementById('server-add-members-sidebar-btn');

let dmHomeFilter = 'online';
let sidebarViewMode = 'channels';

let voiceLocalStream = null;
let voiceRawStream = null;
let voiceNoiseChain = null;
let voiceNoiseActive = null;
let voicePeerConnections = {};
let voiceJoined = false;
let voiceMuted = false;
let voiceChannelId = null;
let voiceRestartAttempts = {};
let livestreamAudioElements = {};
let livestreamMutedByUser = {};
let voiceScreenStreamAudio = null;
const VOICE_DEBUG = true;
function vlog(...args) {
  if (VOICE_DEBUG) console.log('[VOICE]', ...args);
}
let voiceAudioContext = null;
let voiceAnalyser = null;
let voiceVadFrame = null;
let voiceIsSpeaking = false;
let voiceAudioElements = {}; // userId -> <audio> element
let voiceIceCandidateQueues = {}; // userId -> pending ICE candidates
let voiceScreenSharing = false;
let voiceScreenStream = null;

let voiceParticipantsByChannel = {};
let screenSharersByChannel = {};
let typingUsers = {};
let miniplayerVisible = false;
let draggedChannelId = null;

let unreadCounts = {};
let mentionCounts = {};
let lastReadByChannel = {};
let stickToBottom = true;
let rejoinChannelId = null;
let rejoinVoiceId = null;
let rejoinVoiceWasActive = false;
let voiceChatOpen = false;
let focusedScreenUserId = null;
let pipDismissed = false;
let voiceCameraOn = false;
let voiceCameraStream = null;
let remoteCameraStreams = {};
let pendingVideoKinds = {};
let onlineUsersData = [];
let allUsersData = [];

const miniplayer = document.getElementById('miniplayer');
const miniplayerChannelName = document.getElementById('miniplayer-channel-name');
const miniplayerMuteBtn = document.getElementById('miniplayer-mute-btn');
const miniplayerLeaveBtn = document.getElementById('miniplayer-leave-btn');
const miniplayerSpeaking = document.getElementById('miniplayer-speaking');
const typingIndicator = document.getElementById('typing-indicator');
const typingText = document.getElementById('typing-text');
const emojiBtn = document.getElementById('emoji-btn');
const emojiPickerContainer = document.getElementById('emoji-picker-container');
const emojiPicker = emojiPickerContainer.querySelector('emoji-picker');
const floatingScreenShare = document.getElementById('floating-screen-share');
const floatingScreenLabel = document.getElementById('floating-screen-label');
const floatingScreenContainer = document.getElementById('floating-screen-container');
const floatingScreenCloseBtn = document.getElementById('floating-screen-close-btn');
const reactionPicker = document.getElementById('reaction-picker');
const reactionEmojiPicker = document.getElementById('reaction-emoji-picker');
const jumpToPresentBtn = document.getElementById('jump-to-present');
const jumpToUnreadBtn = document.getElementById('jump-to-unread');
const mentionDropdown = document.getElementById('mention-dropdown');
const contextMenu = document.getElementById('context-menu');
const contextMenuItems = document.getElementById('context-menu-items');
const quickSwitcherModal = document.getElementById('quick-switcher-modal');
const quickSwitcherInput = document.getElementById('quick-switcher-input');
const quickSwitcherResults = document.getElementById('quick-switcher-results');
const quickSwitcherBtn = document.getElementById('quick-switcher-btn');
const chatDragOverlay = document.getElementById('chat-drag-overlay');
const chatDragChannelName = document.getElementById('chat-drag-channel-name');
let quickSwitcherSelectedIndex = 0;
let quickSwitcherFilteredItems = [];
let chatDragCounter = 0;
const statusPickerMenu = document.getElementById('status-picker-menu');
const statusPickerCloseBtn = document.getElementById('status-picker-close-btn');
const customStatusInput = document.getElementById('custom-status-input');
const customStatusSaveBtn = document.getElementById('custom-status-save-btn');
const customStatusClearBtn = document.getElementById('custom-status-clear-btn');
const userStatusDot = document.getElementById('user-status-dot');
const userCustomStatusEl = document.getElementById('user-custom-status');
let isAutoIdle = false;
let lastUserActivityTime = Date.now();
const searchBtn = document.getElementById('search-btn');
const searchModal = document.getElementById('search-modal');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchModalClose = document.getElementById('search-modal-close');
const searchScopeChannel = document.getElementById('search-scope-channel');
const searchScopeAll = document.getElementById('search-scope-all');
let currentSearchScope = 'channel';
let searchDebounceTimer = null;

const pinnedBtn = document.getElementById('pinned-btn');
const pinnedCountBadge = document.getElementById('pinned-count-badge');
const pinnedDrawer = document.getElementById('pinned-drawer');
const pinnedDrawerClose = document.getElementById('pinned-drawer-close');
const pinnedMessagesList = document.getElementById('pinned-messages-list');

/* ── Themed Modal Dialog System ────────────────────────────────────────── */
let mellowDialogResolve = null;

function showConfirmModal({
  title = 'Confirm',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    if (mellowDialogResolve) {
      mellowDialogResolve(false);
      mellowDialogResolve = null;
    }
    const modal = document.getElementById('mellow-dialog-modal');
    if (!modal) {
      resolve(false);
      return;
    }
    const titleEl = document.getElementById('mellow-dialog-title');
    const msgEl = document.getElementById('mellow-dialog-message');
    const inputEl = document.getElementById('mellow-dialog-input');
    const errorEl = document.getElementById('mellow-dialog-error');
    const confirmBtn = document.getElementById('mellow-dialog-confirm-btn');
    const cancelBtn = document.getElementById('mellow-dialog-cancel-btn');
    const iconEl = document.getElementById('mellow-dialog-icon');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (inputEl) {
      inputEl.style.display = 'none';
      inputEl.value = '';
    }
    if (errorEl) {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }

    if (cancelBtn) {
      cancelBtn.style.display = '';
      cancelBtn.textContent = cancelText;
    }

    if (confirmBtn) {
      confirmBtn.textContent = confirmText;
      confirmBtn.className = danger ? 'btn-danger' : 'btn-primary';
    }

    if (iconEl) {
      iconEl.className = 'mellow-dialog-icon' + (danger ? ' danger' : '');
      iconEl.innerHTML = danger
        ? '<i class="ph-bold ph-warning"></i>'
        : '<i class="ph-bold ph-question"></i>';
    }

    const cleanup = () => {
      modal.style.display = 'none';
      mellowDialogResolve = null;
      document.removeEventListener('keydown', onKeyDown);
      if (confirmBtn) confirmBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      modal.onclick = null;
    };

    const handleConfirm = () => {
      cleanup();
      resolve(true);
    };

    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (typeof document !== 'undefined' && document.activeElement === cancelBtn) {
          handleCancel();
        } else {
          handleConfirm();
        }
      }
    };

    if (confirmBtn) confirmBtn.onclick = handleConfirm;
    if (cancelBtn) cancelBtn.onclick = handleCancel;
    modal.onclick = (e) => {
      if (e.target === modal) {
        handleCancel();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    mellowDialogResolve = (val) => {
      cleanup();
      resolve(Boolean(val));
    };

    modal.style.display = 'flex';
    if (confirmBtn && typeof confirmBtn.focus === 'function') confirmBtn.focus();
  });
}

function showAlertModal({
  title = 'Notice',
  message = '',
  okText = 'OK',
  type = 'info'
} = {}) {
  return new Promise((resolve) => {
    if (mellowDialogResolve) {
      mellowDialogResolve(false);
      mellowDialogResolve = null;
    }
    const modal = document.getElementById('mellow-dialog-modal');
    if (!modal) {
      resolve();
      return;
    }
    const titleEl = document.getElementById('mellow-dialog-title');
    const msgEl = document.getElementById('mellow-dialog-message');
    const inputEl = document.getElementById('mellow-dialog-input');
    const errorEl = document.getElementById('mellow-dialog-error');
    const confirmBtn = document.getElementById('mellow-dialog-confirm-btn');
    const cancelBtn = document.getElementById('mellow-dialog-cancel-btn');
    const iconEl = document.getElementById('mellow-dialog-icon');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (inputEl) {
      inputEl.style.display = 'none';
      inputEl.value = '';
    }
    if (errorEl) {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }

    if (cancelBtn) {
      cancelBtn.style.display = 'none';
    }

    const isDanger = type === 'danger' || type === 'error';
    const isWarning = type === 'warning';
    const isSuccess = type === 'success';

    if (confirmBtn) {
      confirmBtn.textContent = okText;
      confirmBtn.className = isDanger ? 'btn-danger' : 'btn-primary';
    }

    if (iconEl) {
      const typeClass = isDanger ? ' danger' : isWarning ? ' warning' : isSuccess ? ' success' : '';
      iconEl.className = 'mellow-dialog-icon' + typeClass;
      let iconMarkup = '<i class="ph-bold ph-info"></i>';
      if (isDanger) iconMarkup = '<i class="ph-bold ph-warning-circle"></i>';
      else if (isWarning) iconMarkup = '<i class="ph-bold ph-warning"></i>';
      else if (isSuccess) iconMarkup = '<i class="ph-bold ph-check-circle"></i>';
      iconEl.innerHTML = iconMarkup;
    }

    const cleanup = () => {
      modal.style.display = 'none';
      mellowDialogResolve = null;
      document.removeEventListener('keydown', onKeyDown);
      if (confirmBtn) confirmBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      modal.onclick = null;
    };

    const handleClose = () => {
      cleanup();
      resolve();
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        handleClose();
      }
    };

    if (confirmBtn) confirmBtn.onclick = handleClose;
    modal.onclick = (e) => {
      if (e.target === modal) {
        handleClose();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    mellowDialogResolve = () => {
      cleanup();
      resolve();
    };

    modal.style.display = 'flex';
    if (confirmBtn && typeof confirmBtn.focus === 'function') confirmBtn.focus();
  });
}

function showPromptModal({
  title = 'Prompt',
  message = '',
  defaultValue = '',
  placeholder = '',
  confirmText = 'OK',
  cancelText = 'Cancel'
} = {}) {
  return new Promise((resolve) => {
    if (mellowDialogResolve) {
      mellowDialogResolve(null);
      mellowDialogResolve = null;
    }
    const modal = document.getElementById('mellow-dialog-modal');
    if (!modal) {
      resolve(null);
      return;
    }
    const titleEl = document.getElementById('mellow-dialog-title');
    const msgEl = document.getElementById('mellow-dialog-message');
    const inputEl = document.getElementById('mellow-dialog-input');
    const errorEl = document.getElementById('mellow-dialog-error');
    const confirmBtn = document.getElementById('mellow-dialog-confirm-btn');
    const cancelBtn = document.getElementById('mellow-dialog-cancel-btn');
    const iconEl = document.getElementById('mellow-dialog-icon');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (inputEl) {
      inputEl.style.display = 'block';
      inputEl.value = defaultValue || '';
      inputEl.placeholder = placeholder || '';
    }
    if (errorEl) {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }

    if (cancelBtn) {
      cancelBtn.style.display = '';
      cancelBtn.textContent = cancelText;
    }

    if (confirmBtn) {
      confirmBtn.textContent = confirmText;
      confirmBtn.className = 'btn-primary';
    }

    if (iconEl) {
      iconEl.className = 'mellow-dialog-icon';
      iconEl.innerHTML = '<i class="ph-bold ph-pencil-simple"></i>';
    }

    const cleanup = () => {
      modal.style.display = 'none';
      mellowDialogResolve = null;
      document.removeEventListener('keydown', onKeyDown);
      if (confirmBtn) confirmBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (inputEl) inputEl.onkeydown = null;
      modal.onclick = null;
    };

    const handleConfirm = () => {
      const val = inputEl ? inputEl.value : '';
      cleanup();
      resolve(val);
    };

    const handleCancel = () => {
      cleanup();
      resolve(null);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };

    if (inputEl) {
      inputEl.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleConfirm();
        }
      };
    }

    if (confirmBtn) confirmBtn.onclick = handleConfirm;
    if (cancelBtn) cancelBtn.onclick = handleCancel;
    modal.onclick = (e) => {
      if (e.target === modal) {
        handleCancel();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    mellowDialogResolve = (val) => {
      cleanup();
      resolve(val !== undefined ? val : null);
    };

    modal.style.display = 'flex';
    if (inputEl) {
      setTimeout(() => {
        if (typeof inputEl.focus === 'function') inputEl.focus();
        if (typeof inputEl.select === 'function') inputEl.select();
      }, 20);
    }
  });
}

function showContextMenu(x, y, items) {
  contextMenuItems.innerHTML = '';
  items.forEach(item => {
    if (item.type === 'divider') {
      const div = document.createElement('div');
      div.className = 'ctx-menu-divider';
      contextMenuItems.appendChild(div);
    } else if (item.type === 'header') {
      const div = document.createElement('div');
      div.className = 'ctx-menu-header';
      div.textContent = item.label;
      contextMenuItems.appendChild(div);
    } else if (item.type === 'slider') {
      const div = document.createElement('div');
      div.className = 'ctx-menu-slider';
      div.innerHTML = `
        <div class="ctx-slider-label">
          <span>${escapeHtml(item.label || 'Volume')}</span>
          <span class="ctx-slider-val">${Math.round((item.value !== undefined ? item.value : 1) * 100)}%</span>
        </div>
        <input type="range" min="0" max="1" step="0.05" value="${item.value !== undefined ? item.value : 1}">
      `;
      const slider = div.querySelector('input');
      const valSpan = div.querySelector('.ctx-slider-val');
      slider.addEventListener('input', (e) => {
        e.stopPropagation();
        const val = parseFloat(e.target.value);
        valSpan.textContent = `${Math.round(val * 100)}%`;
        if (item.onInput) item.onInput(val);
      });
      slider.addEventListener('click', (e) => e.stopPropagation());
      contextMenuItems.appendChild(div);
    } else if (item.type === 'profile') {
      const div = document.createElement('div');
      div.className = 'ctx-profile';
      const avatarUrl = item.profilePic || getDefaultAvatar(item.username);
      const avatarHtml = `<img src="${avatarUrl}" alt="${escapeHtml(item.username)}">`;
      div.innerHTML = `<div class="ctx-profile-avatar">${avatarHtml}</div>
        <span class="ctx-profile-name">${escapeHtml(item.username)}</span>
        <span class="ctx-profile-role">${item.role || 'User'}</span>`;
      contextMenuItems.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'ctx-menu-item' + (item.danger ? ' danger' : '');
      if (item.icon) {
        div.innerHTML = `${item.icon}<span>${escapeHtml(item.label)}</span>`;
      } else {
        div.textContent = item.label;
      }
      div.onclick = (e) => {
        e.stopPropagation();
        hideContextMenu();
        if (item.action) item.action();
      };
      contextMenuItems.appendChild(div);
    }
  });
  contextMenu.style.display = 'block';
  const menuW = contextMenu.offsetWidth;
  const menuH = contextMenu.offsetHeight;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
}

function hideContextMenu() {
  contextMenu.style.display = 'none';
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', () => hideContextMenu());

function connectWS() {
  wsAuthenticated = false;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    ws = new WebSocket(`${proto}//${window.location.host}`);
  } catch (err) {
    console.warn('WebSocket init failed:', err);
    setTimeout(connectWS, 2000);
    return;
  }

  ws.onopen = () => {
    const authToken = token || localStorage.getItem('token');
    ws.send(JSON.stringify({ type: 'auth', token: authToken }));
  };

  ws.onerror = (err) => {
    console.warn('WebSocket error, reconnecting soon...');
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'channels') {
      wsAuthenticated = true;
      const banner = document.getElementById('connection-banner');
      if (banner) banner.style.display = 'none';
      if (data.allUsers) allUsersData = data.allUsers;
      if (rejoinChannelId) {
        const rejoin = rejoinChannelId;
        rejoinChannelId = null;
        sendWS('channel:join', { channelId: rejoin });
      }
      if (rejoinVoiceId && rejoinVoiceWasActive) {
        const rejoinV = rejoinVoiceId;
        rejoinVoiceId = null;
        rejoinVoiceWasActive = false;
        rejoinVoiceChannel(rejoinV);
      }
    }
    await handleWSMessage(data);
  };

  ws.onclose = () => {
    wsAuthenticated = false;
    const banner = document.getElementById('connection-banner');
    if (banner) banner.style.display = 'flex';
    rejoinChannelId = currentChannelId;
    rejoinVoiceId = voiceJoined ? voiceChannelId : null;
    rejoinVoiceWasActive = voiceJoined;
    leaveVoiceChannel(true);
    setTimeout(connectWS, 2000);
  };
}

let customSendWSHook = null;

function sendWS(type, payload = {}) {
  if (customSendWSHook) {
    customSendWSHook(type, payload);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN || !wsAuthenticated) {
    const banner = document.getElementById('connection-banner');
    if (banner) banner.style.display = 'flex';
    return;
  }
  ws.send(JSON.stringify({ type, ...payload }));
}

async function handleWSMessage(data) {
  switch (data.type) {
    case 'channels':
      if (Array.isArray(data.servers)) {
        servers = data.servers;
        if (servers.length > 0) {
          if (!servers.some(s => s.id === currentServerId)) {
            currentServerId = servers[0].id;
          }
        } else {
          currentServerId = null;
        }
        renderServerRail();
      }
      channels = data.channels || [];
      lastReadByChannel = data.readState || {};
      if (data.unreadCounts) unreadCounts = { ...data.unreadCounts };
      renderChannels();
      break;

    case 'server:created': {
      if (data.server) {
        if (!servers.some(s => s.id === data.server.id)) {
          servers.push(data.server);
        }
        switchServer(data.server.id);
      }
      break;
    }

    case 'server:updated': {
      if (data.server) {
        const idx = servers.findIndex(s => s.id === data.server.id);
        if (idx !== -1) {
          servers[idx] = data.server;
        } else {
          servers.push(data.server);
        }
        renderServerRail();
        if (serverMembersModal && serverMembersModal.style.display === 'flex') {
          renderServerMembersModal();
        }
        renderChannels();
        renderOnlineUsers(onlineUsersData);
      }
      break;
    }

    case 'server:deleted': {
      servers = servers.filter(s => s.id !== data.serverId);
      renderServerRail();
      if (currentServerId === data.serverId) {
        const fallbackServer = servers.find(s => s.id === 'default-server') || servers[0];
        if (fallbackServer) {
          switchServer(fallbackServer.id);
        } else {
          setSidebarMode('dms');
          showDmHomeView();
        }
      }
      break;
    }

    case 'category:created': {
      const s = servers.find(srv => srv.id === data.serverId);
      if (s) {
        if (!s.categories) s.categories = [];
        if (!s.categories.some(c => c.id === data.category.id)) {
          s.categories.push(data.category);
        }
        if (currentServerId === data.serverId) {
          renderChannels();
        }
      }
      break;
    }

    case 'channel:reordered': {
      const ch = channels.find(c => c.id === data.channelId);
      if (ch) {
        if (data.categoryId !== undefined) ch.categoryId = data.categoryId;
        if (data.order !== undefined) ch.order = data.order;
        renderChannels();
      }
      break;
    }

    case 'channel:activity':
      if (data.channelId !== currentChannelId && data.senderId !== (currentUser && currentUser.id)) {
        unreadCounts[data.channelId] = (unreadCounts[data.channelId] || 0) + 1;
        const targetCh = channels.find(c => c.id === data.channelId);
        if (targetCh) {
          targetCh.lastMessageAt = data.timestamp || Date.now();
        }
        const isDM = (targetCh && targetCh.type === 'dm') || data.channelType === 'dm';
        const isVoice = (targetCh && targetCh.type === 'voice') || data.channelType === 'voice';

        // Do not play notification sounds for voice channels (VC text chats)
        if (!isVoice) {
          const setting = getNotificationSetting();
          if (setting === 'all') {
            playSound('chat');
          } else if (setting === 'mentions' && isDM) {
            playSound('chat');
          }
        }
        if (isDM) {
          mentionCounts[data.channelId] = (mentionCounts[data.channelId] || 0) + 1;
          renderDMs();
          notifyDesktopFor(data, true);
        }
        renderUnreadBadges();
      }
      break;

    case 'channel:sync': {
      const idx = channels.findIndex(c => c.id === data.channel.id);
      if (idx === -1) {
        channels.push(data.channel);
      } else {
        channels[idx] = { ...channels[idx], ...data.channel };
      }
      renderChannels();
      break;
    }

    case 'messages':
      renderMessages(data.channelId, data.messages);
      if (Array.isArray(data.messages) && data.messages.length > 0) {
        const lastM = data.messages[data.messages.length - 1];
        const ch = channels.find(c => c.id === data.channelId);
        if (ch && (!ch.lastMessageAt || lastM.timestamp > ch.lastMessageAt)) {
          ch.lastMessageAt = lastM.timestamp;
          if (ch.type === 'dm') {
            renderDMs();
          }
        }
      }
      break;

    case 'message:new': {
      addMessage(data.channelId, data.message);
      const ch = channels.find(c => c.id === data.channelId);
      if (ch) {
        ch.lastMessageAt = data.message.timestamp;
        if (ch.type === 'dm') {
          if (archivedDmIds.includes(data.channelId)) {
            archivedDmIds = archivedDmIds.filter(id => id !== data.channelId);
            saveArchivedDms();
          }
          renderDMs();
        }
      }
      const isVoice = (ch && ch.type === 'voice');
      const isDM = (ch && ch.type === 'dm');
      const isMentioned = isDM || (data.message.text && (data.message.text.includes('@everyone') || (currentUser && data.message.text.includes('@' + currentUser.username))));
      if (data.message.userId !== currentUser.id && data.channelId === currentChannelId && !isVoice) {
        const setting = getNotificationSetting();
        if (setting === 'all' || (setting === 'mentions' && isMentioned)) {
          playSound(isMentioned ? 'mention' : 'chat');
        }
      }
      break;
    }

    case 'message:edited':
      handleMessageEdited(data);
      break;

    case 'message:deleted':
      removeMessage(data.channelId, data.messageId);
      break;

    case 'channel:created': {
      const idx = channels.findIndex(c => c.id === data.channel.id);
      if (idx === -1) {
        channels.push(data.channel);
      } else {
        channels[idx] = { ...channels[idx], ...data.channel };
      }
      if (data.channel.type === 'dm') {
        if (archivedDmIds.includes(data.channel.id)) {
          archivedDmIds = archivedDmIds.filter(id => id !== data.channel.id);
          saveArchivedDms();
        }
      }
      renderChannels();
      if (data.channel.type === 'dm') {
        if (data.isCreator !== false) {
          switchChannel(data.channel.id);
        }
      }
      break;
    }

    case 'channel:deleted': {
      const deletedId = data.channelId;
      const targetChannel = channels.find(c => c.id === deletedId);
      const isDeletedDM = targetChannel && targetChannel.type === 'dm';
      if (voiceChannelId === deletedId) {
        leaveVoiceChannel(true);
      }
      delete voiceParticipantsByChannel[deletedId];
      delete screenSharersByChannel[deletedId];
      channels = channels.filter(c => c.id !== deletedId);
      if (archivedDmIds.includes(deletedId)) {
        archivedDmIds = archivedDmIds.filter(id => id !== deletedId);
        saveArchivedDms();
      }
      if (currentChannelId === deletedId) {
        if (isDeletedDM || sidebarViewMode === 'dms') {
          showDmHomeView();
        } else if (channels.length > 0) {
          switchChannel(channels[0].id);
        } else {
          showDmHomeView();
        }
      }
      renderChannels();
      break;
    }

    case 'channel:renamed': {
      const ch = channels.find(c => c.id === data.channelId);
      if (ch) {
        ch.name = data.name;
        if (currentChannelId === data.channelId) {
          setChannelNameTitle(ch, `# ${data.name}`);
        }
      }
      renderChannels();
      break;
    }

    case 'channel:permissions:updated': {
      const { channelId, canAccess, channel: updatedCh } = data;
      if (!canAccess) {
        if (voiceChannelId === channelId) {
          leaveVoiceChannel(true);
        }
        delete voiceParticipantsByChannel[channelId];
        delete screenSharersByChannel[channelId];
        channels = channels.filter(c => c.id !== channelId);
        if (currentChannelId === channelId) {
          const visibleServerChannels = channels.filter(c => c.type !== 'dm' && (c.serverId || 'default-server') === currentServerId);
          if (visibleServerChannels.length > 0) {
            switchChannel(visibleServerChannels[0].id);
          } else if (channels.length > 0) {
            switchChannel(channels[0].id);
          } else {
            currentChannelId = null;
            const title = document.getElementById('current-channel-name');
            if (title) title.textContent = 'No channels accessible';
            const msgBox = document.getElementById('messages');
            if (msgBox) msgBox.innerHTML = '';
          }
        }
      } else if (updatedCh) {
        const idx = channels.findIndex(c => c.id === channelId);
        if (idx === -1) {
          channels.push(updatedCh);
        } else {
          channels[idx] = { ...channels[idx], ...updatedCh };
        }
        if (currentChannelId === channelId) {
          setChannelNameTitle(updatedCh, `# ${updatedCh.name}`);
        }
      }
      renderChannels();
      break;
    }

    case 'users:online':
      renderOnlineUsers(data.users);
      if (currentUser) {
        const myPresence = data.users.find(u => u.id === currentUser.id);
        if (myPresence) {
          if (myPresence.status) currentUser.status = myPresence.status;
          if (myPresence.customStatus !== undefined) currentUser.customStatus = myPresence.customStatus;
          updateUserStatusDisplay();
        }
      }
      break;

    case 'user:status:updated':
      if (currentUser) {
        currentUser.status = data.status;
        currentUser.customStatus = data.customStatus;
        updateUserStatusDisplay();
      }
      break;

    case 'user:kicked': {
      if (currentUser && data.userId === currentUser.id) {
        localStorage.removeItem('token');
        location.reload();
        break;
      }
      const uIdx = allUsersData.findIndex(u => u.id === data.userId);
      let newName = data.user ? data.user.username : null;
      if (uIdx !== -1) {
        allUsersData[uIdx].isDeleted = true;
        allUsersData[uIdx].status = 'offline';
        allUsersData[uIdx].username = data.user ? data.user.username : `deleted-user(${allUsersData[uIdx].username})`;
        newName = allUsersData[uIdx].username;
      } else if (data.user) {
        allUsersData.push({ ...data.user, status: 'offline' });
        newName = data.user.username;
      }
      onlineUsersData = onlineUsersData.filter(u => u.id !== data.userId);
      renderOnlineUsers(onlineUsersData);

      // Update DM channel names & render channels
      channels.forEach(ch => {
        if (ch.type === 'dm' && ch.dmUser && ch.dmUser.id === data.userId) {
          ch.dmUser.isDeleted = true;
          if (newName) ch.dmUser.username = newName;
        }
      });
      renderChannels(channels);

      // Update active DM channel header if viewing this DM
      const activeCh = channels.find(c => c.id === currentChannelId);
      if (activeCh && activeCh.type === 'dm' && activeCh.dmUser && activeCh.dmUser.id === data.userId) {
        currentChannelName.textContent = `@ ${newName || 'deleted-user'}`;
        messageInput.placeholder = `Message @${newName || 'deleted-user'}`;
        updateDmProfileCard(activeCh.dmUser);
      }

      // Update message author headers in current chat view
      if (newName) {
        document.querySelectorAll(`#messages-container .message[data-user-id="${data.userId}"]`).forEach(msg => {
          const nameEl = msg.querySelector('.message-username');
          if (nameEl) nameEl.textContent = newName;
        });
      }

      if (adminModal && adminModal.style.display === 'flex') loadAdminUsers();
      break;
    }

    case 'admin:pending:list': {
      renderAdminPendingRequests(data.requests || []);
      break;
    }

    case 'user:registered': {
      if (data.user && !allUsersData.some(u => u.id === data.user.id)) {
        allUsersData.push({ ...data.user });
      }
      if (serverMembersModal && serverMembersModal.style.display === 'flex') {
        renderServerMembersModal();
      }
      if (sidebarViewMode === 'dms') {
        renderDmHomeMembers();
      }
      if (typeof adminModal !== 'undefined' && adminModal && adminModal.style.display === 'flex') {
        loadAdminUsers();
      }
      renderOnlineUsers(onlineUsersData);
      break;
    }

    case 'user:updated': {
      if (data.user.id === currentUser.id) {
        currentUser.username = data.user.username;
        currentUser.role = data.user.role;
        currentUser.profilePic = data.user.profilePic;
        if (data.user.aboutMe !== undefined) currentUser.aboutMe = data.user.aboutMe;
        if (data.user.customStatus !== undefined) currentUser.customStatus = data.user.customStatus;
        if (data.user.status !== undefined) currentUser.status = data.user.status;
        renderUserInfo();
      }
      const allIdx = allUsersData.findIndex(u => u.id === data.user.id);
      if (allIdx !== -1) {
        allUsersData[allIdx] = { ...allUsersData[allIdx], ...data.user };
      } else {
        allUsersData.push({ ...data.user });
      }
      if (adminModal.style.display === 'flex') loadAdminUsers();
      channels.forEach(ch => {
        if (ch.type === 'dm' && ch.dmUser && ch.dmUser.id === data.user.id) {
          ch.dmUser.username = data.user.username;
          ch.dmUser.profilePic = data.user.profilePic;
        }
      });
      document.querySelectorAll(`#messages-container .message[data-user-id="${data.user.id}"]`).forEach(msg => {
        const nameEl = msg.querySelector('.message-username');
        if (nameEl) nameEl.textContent = data.user.username;
        const avatarDiv = msg.querySelector('.message-avatar');
        if (avatarDiv) {
          const avatarUrl = getUserAvatarUrl(data.user);
          avatarDiv.innerHTML = `<img src="${avatarUrl}" alt="${escapeHtml(data.user.username)}">`;
        }
      });
      Object.values(voiceParticipantsByChannel).forEach(list => {
        const p = list.find(x => x.userId === data.user.id);
        if (p) {
          p.username = data.user.username;
          p.profilePic = data.user.profilePic;
        }
      });
      const userListItem = document.getElementById(`user-${data.user.id}`);
      if (userListItem) {
        const avatarEl = userListItem.querySelector('.user-avatar');
        if (avatarEl) {
          const avatarUrl = getUserAvatarUrl(data.user);
          avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${escapeHtml(data.user.username)}">`;
        }
        const nameEl = userListItem.querySelector('.user-name');
        if (nameEl) nameEl.textContent = data.user.username;
      }
      renderChannels();
      renderVoiceParticipants_live();
      renderOnlineUsers(onlineUsersData);
      break;
    }

    case 'user:update:ok': {
      currentUser.username = data.user.username;
      currentUser.role = data.user.role;
      currentUser.profilePic = data.user.profilePic;
      renderUserInfo();
      document.getElementById('settings-username').value = '';
      document.getElementById('settings-password').value = '';
      const curPwEl = document.getElementById('settings-current-password');
      if (curPwEl) curPwEl.value = '';
      document.getElementById('settings-error').textContent = 'Changes saved!';
      document.getElementById('settings-error').style.color = 'var(--success)';
      setTimeout(() => {
        document.getElementById('settings-error').textContent = '';
      }, 3000);
      break;
    }

    case 'kicked':
      localStorage.removeItem('token');
      await showAlertModal({ title: 'Kicked', message: 'You have been kicked by the admin.', type: 'danger' });
      location.reload();
      break;

    case 'voice:all-participants': {
      voiceParticipantsByChannel = data.channels || {};
      screenSharersByChannel = data.screenSharers || {};
      renderChannels();
      break;
    }

    case 'voice:user:joined': {
      if (!voiceParticipantsByChannel[data.channelId]) {
        voiceParticipantsByChannel[data.channelId] = [];
      }
      if (!voiceParticipantsByChannel[data.channelId].find(p => p.userId === data.user.userId)) {
        voiceParticipantsByChannel[data.channelId].push(data.user);
      }
      renderChannels();
      updateVoiceParticipantCount(data.channelId);
      if (voiceJoined && voiceChannelId === data.channelId) {
        if (data.user.userId !== currentUser.id) {
          createPeerConnection(data.user.userId, data.user.username, true);
          playSound('joined');
        }
        renderVoiceParticipants_live();
      }
      break;
    }

    case 'voice:user:left': {
      if (voiceParticipantsByChannel[data.channelId]) {
        voiceParticipantsByChannel[data.channelId] = voiceParticipantsByChannel[data.channelId].filter(p => p.userId !== data.userId);
      }
      if (screenSharersByChannel[data.channelId]) {
        screenSharersByChannel[data.channelId] = screenSharersByChannel[data.channelId].filter(id => id !== data.userId);
      }
      if (focusedScreenUserId === data.userId) {
        focusedScreenUserId = null;
      }
      renderChannels();
      updateVoiceParticipantCount(data.channelId);
      if (voiceJoined && voiceChannelId === data.channelId) {
        if (data.userId !== currentUser.id) {
          closePeerConnection(data.userId);
          playSound('leave');
          const vid = document.getElementById(`vs-${data.userId}`);
          if (vid) { vid.srcObject = null; vid.remove(); }
          removeLivestreamAudio(data.userId);
          applyScreenFocus();
          if (!voiceScreenSharing && !hasAnyScreenShare()) {
            voiceScreenArea.style.display = 'none';
          }
          syncPiP();
          renderVoiceParticipants_live();
        }
      }
      break;
    }

    case 'voice:participants': {
      voiceParticipantsByChannel[data.channelId] = data.participants;
      renderChannels();
      updateVoiceParticipantCount(data.channelId);
      if (voiceJoined && voiceChannelId === data.channelId) {
        renderVoiceParticipants(data.participants);
        data.participants.forEach(p => {
          if (p.userId !== currentUser.id && !voicePeerConnections[p.userId]) {
            const iInitiate = currentUser.id < p.userId;
            createPeerConnection(p.userId, p.username, iInitiate);
          }
        });
        if (voiceScreenSharing && voiceScreenStream) {
          const videoTrack = voiceScreenStream.getVideoTracks()[0];
          const audioTrack = voiceScreenStreamAudio;
          const micTrack = voiceLocalStream ? voiceLocalStream.getAudioTracks()[0] : null;
          if (videoTrack) {
            data.participants.forEach(p => {
              if (p.userId !== currentUser.id) {
                const pc = voicePeerConnections[p.userId];
                if (pc) {
                  if (!pc.screenVideoSender) {
                    pc.screenVideoSender = pc.addTrack(videoTrack, voiceScreenStream);
                    const transceiver = pc.getTransceivers ? pc.getTransceivers().find(t => t.sender === pc.screenVideoSender) : null;
                    if (transceiver) {
                      preferH264VideoCodec(transceiver);
                    }
                    applyHighFpsEncodingParameters(pc.screenVideoSender);
                    renegotiatePeerConnection(p.userId);
                  }
                  const hasScreenAudio = pc.getSenders().some(s => s.track && s.track.kind === 'audio' && s.track !== micTrack);
                  if (!hasScreenAudio && audioTrack) {
                    pc.addTrack(audioTrack, voiceScreenStream);
                    renegotiatePeerConnection(p.userId);
                  }
                }
              }
            });
          }
        }
        if (voiceCameraOn && voiceCameraStream) {
          const cameraTrack = voiceCameraStream.getVideoTracks()[0];
          if (cameraTrack) {
            data.participants.forEach(p => {
              if (p.userId !== currentUser.id) {
                const pc = voicePeerConnections[p.userId];
                if (pc && !pc.cameraVideoSender) {
                  pc.cameraVideoSender = pc.addTrack(cameraTrack, voiceCameraStream);
                  renegotiatePeerConnection(p.userId);
                }
              }
            });
          }
        }
      }
      break;
    }

    case 'voice:mute': {
      const room = voiceParticipantsByChannel[data.channelId];
      if (room) {
        const p = room.find(x => x.userId === data.userId);
        if (p) p.muted = data.muted;
      }
      renderChannels();
      if (voiceJoined && voiceChannelId === data.channelId) {
        renderVoiceParticipants_live();
      }
      break;
    }

    case 'voice:camera': {
      const room = voiceParticipantsByChannel[data.channelId];
      if (room) {
        const p = room.find(x => x.userId === data.userId);
        if (p) p.cameraOn = data.cameraOn;
      }
      if (data.cameraOn) {
        if (!pendingVideoKinds[data.userId]) pendingVideoKinds[data.userId] = [];
        pendingVideoKinds[data.userId].push('camera');
      } else {
        const cam = document.getElementById(`cam-${data.userId}`);
        if (cam) { cam.srcObject = null; cam.remove(); }
        delete remoteCameraStreams[data.userId];
      }
      renderChannels();
      if (voiceJoined && voiceChannelId === data.channelId) {
        renderVoiceParticipants_live();
      }
      break;
    }

    case 'voice:offer':
      if (voiceJoined && data.userId !== currentUser.id) {
        handleVoiceOffer(data.userId, data.sdp);
      }
      break;

    case 'voice:answer':
      if (voiceJoined && data.userId !== currentUser.id) {
        handleVoiceAnswer(data.userId, data.sdp);
      }
      break;

    case 'voice:ice-candidate':
      if (voiceJoined && data.userId !== currentUser.id) {
        handleVoiceIceCandidate(data.userId, data.candidate);
      }
      break;

    case 'voice:speaking': {
      if (voiceJoined && voiceChannelId === data.channelId) {
        const el = document.getElementById(`vp-${data.userId}`);
        if (el) {
          const avatar = el.querySelector('.user-avatar');
          if (avatar) avatar.classList.toggle('speaking', !!data.speaking);
        }
        if (data.userId === currentUser.id) {
          miniplayerSpeaking.style.display = data.speaking ? 'inline' : 'none';
        }
      }
      break;
    }

    case 'typing:start':
      handleTypingStart(data);
      break;

    case 'typing:stop':
      handleTypingStop(data);
      break;

    case 'message:pin':
      handleMessagePin(data);
      break;

    case 'message:unpin':
      handleMessageUnpin(data);
      break;

    case 'message:reacted': {
      const el = document.getElementById(`msg-${data.messageId}`);
      if (el) {
        const reactionsDiv = el.querySelector('.message-reactions');
        if (reactionsDiv) renderReactions(reactionsDiv, data.messageId, data.reactions);
      }
      break;
    }

    case 'message:mention': {
      if (data.channelId !== currentChannelId) {
        if (!mentionCounts[data.channelId]) mentionCounts[data.channelId] = 0;
        mentionCounts[data.channelId]++;
        renderUnreadBadges();
      }
      playSound('mention');
      if (!(currentUser && currentUser.status === 'dnd') && getNotificationSetting() !== 'mute'
          && (document.hidden || !document.hasFocus())) {
        const m = data.message || {};
        notifyDesktop(
          `${m.username || 'Someone'} mentioned you`,
          String(m.text || '').slice(0, 120)
        );
      }
      break;
    }

    case 'channels:reordered': {
      channels = data.channels;
      renderChannels();
      break;
    }

    case 'voice:channel:closed':
      await showAlertModal({ title: 'Channel Deleted', message: 'Voice channel has been deleted.', type: 'info' });
      leaveVoiceChannel(true);
      break;

    case 'voice:screen:started': {
      if (!screenSharersByChannel[data.channelId]) screenSharersByChannel[data.channelId] = [];
      if (!screenSharersByChannel[data.channelId].includes(data.userId)) {
        screenSharersByChannel[data.channelId].push(data.userId);
      }
      if (!pendingVideoKinds[data.userId]) pendingVideoKinds[data.userId] = [];
      pendingVideoKinds[data.userId].push('screen');
      renderChannels();
      renderVoiceParticipants_live();
      break;
    }

    case 'voice:screen:stopped': {
      if (screenSharersByChannel[data.channelId]) {
        screenSharersByChannel[data.channelId] = screenSharersByChannel[data.channelId].filter(id => id !== data.userId);
      }
      if (focusedScreenUserId === data.userId) {
        focusedScreenUserId = null;
      }
      const stoppedVideo = document.getElementById(`vs-${data.userId}`);
      if (stoppedVideo) {
        stoppedVideo.srcObject = null;
        stoppedVideo.remove();
      }
      removeLivestreamAudio(data.userId);
      applyScreenFocus();
      if (!voiceScreenSharing && !hasAnyScreenShare()) {
        voiceScreenArea.style.display = 'none';
      }
      syncPiP();
      renderChannels();
      renderVoiceParticipants_live();
      break;
    }

    case 'dm:call:incoming': {
      if (currentUser && (currentUser.status === 'dnd' || currentUser.status === "dnd")) {
        sendWS('dm:call:decline', { channelId: data.channelId });
        break;
      }
      currentIncomingCall = { channelId: data.channelId, caller: data.caller };
      const dmIncomingModal = document.getElementById('dm-incoming-call-modal');
      const dmIncomingAvatar = document.getElementById('dm-incoming-avatar');
      const dmIncomingUsername = document.getElementById('dm-incoming-username');
      if (dmIncomingAvatar) {
        dmIncomingAvatar.src = (data.caller && data.caller.profilePic) || (data.caller ? getDefaultAvatar(data.caller.id) : getDefaultAvatar());
      }
      if (dmIncomingUsername) {
        dmIncomingUsername.textContent = data.caller ? data.caller.username : 'Someone';
      }
      if (dmIncomingModal) dmIncomingModal.style.display = 'flex';
      startRingtone();
      break;
    }

    case 'dm:call:ringing': {
      const dmCallingStatus = document.getElementById('dm-calling-status');
      if (dmCallingStatus) dmCallingStatus.textContent = 'Ringing...';
      break;
    }

    case 'dm:call:accepted': {
      stopRingtone();
      const dmCallingModal = document.getElementById('dm-calling-modal');
      if (dmCallingModal) dmCallingModal.style.display = 'none';
      const callChannelId = data.channelId;
      currentActiveDmCall = null;
      if (currentChannelId !== callChannelId) {
        switchChannel(callChannelId);
      }
      joinVoiceChannel(false, callChannelId);
      break;
    }

    case 'dm:call:declined': {
      stopRingtone();
      const dmCallingStatus = document.getElementById('dm-calling-status');
      if (dmCallingStatus) dmCallingStatus.textContent = 'Call declined';
      setTimeout(() => {
        const dmCallingModal = document.getElementById('dm-calling-modal');
        if (dmCallingModal) dmCallingModal.style.display = 'none';
      }, 1500);
      currentActiveDmCall = null;
      break;
    }

    case 'dm:call:cancelled': {
      stopRingtone();
      const dmIncomingModal = document.getElementById('dm-incoming-call-modal');
      if (dmIncomingModal) dmIncomingModal.style.display = 'none';
      currentIncomingCall = null;
      break;
    }

    case 'dm:call:failed': {
      stopRingtone();
      const dmCallingStatus = document.getElementById('dm-calling-status');
      if (dmCallingStatus) dmCallingStatus.textContent = data.reason || 'Call unavailable';
      setTimeout(() => {
        const dmCallingModal = document.getElementById('dm-calling-modal');
        if (dmCallingModal) dmCallingModal.style.display = 'none';
      }, 1500);
      currentActiveDmCall = null;
      break;
    }

    case 'error':
      await showAlertModal({ title: 'Error', message: data.message, type: 'danger' });
      break;
  }
}

/* Auth */

let currentAuthTab = 'login';
let approvalWait = null; // { username } while waiting for admin approval
let approvalGen = 0;
let approvalTimer = null;

function setAuthMessage(text, tone) {
  authError.textContent = text;
  authError.style.color = tone === 'info' ? 'var(--text-muted)' : '';
}

function resetAuthSubmitButton() {
  authSubmit.disabled = false;
  authSubmit.textContent = currentAuthTab === 'login' ? 'Login' : 'Register';
}

function stopApprovalWait() {
  approvalGen += 1;
  if (approvalTimer) {
    clearInterval(approvalTimer);
    approvalTimer = null;
  }
  approvalWait = null;
  if (authBootstrapEl) authBootstrapEl.style.display = 'none';
  if (authCodeEl) authCodeEl.value = '';
}

const authBootstrapEl = document.getElementById('auth-bootstrap');
const authCodeEl = document.getElementById('auth-code');
const authCodeConfirmBtn = document.getElementById('auth-code-confirm');

async function confirmWithCode() {
  if (!approvalWait) return;
  const username = approvalWait.username;
  const code = authCodeEl ? authCodeEl.value.trim() : '';
  if (!/^\d{6}$/.test(code)) {
    setAuthMessage('Enter the 6-digit code from the server console.', 'error');
    return;
  }
  if (authCodeConfirmBtn) authCodeConfirmBtn.disabled = true;
  try {
    const res = await fetch('/api/register/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, code })
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthMessage(data.error || 'Could not confirm the code.', 'error');
      return;
    }
    stopApprovalWait();
    await completeAuthLogin(data);
  } catch (_) {
    setAuthMessage('Connection error', 'error');
  } finally {
    if (authCodeConfirmBtn) authCodeConfirmBtn.disabled = false;
  }
}

if (authCodeConfirmBtn) authCodeConfirmBtn.addEventListener('click', confirmWithCode);

authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    authTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentAuthTab = tab.dataset.tab;
    stopApprovalWait();
    setAuthMessage('', '');
    resetAuthSubmitButton();
  });
});

authUsername.addEventListener('input', () => {
  if (approvalWait) {
    stopApprovalWait();
    setAuthMessage('', '');
    resetAuthSubmitButton();
  }
});
authPassword.addEventListener('input', () => {
  if (approvalWait) {
    stopApprovalWait();
    setAuthMessage('', '');
    resetAuthSubmitButton();
  }
});

async function completeAuthLogin(data) {
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('token', token);

  // Init sounds here — inside the submit user-gesture when available
  try {
    await initSounds();
  } catch (_) {}
  document.addEventListener('click', triggerSoundInit);
  document.addEventListener('keydown', triggerSoundInit);

  showApp();
  connectWS();
}

function beginApprovalWait(username, password) {
  stopApprovalWait();
  const gen = approvalGen;
  approvalWait = { username };
  authSubmit.disabled = true;
  authSubmit.textContent = 'Waiting...';
  setAuthMessage('Request sent!', 'info');
  if (authBootstrapEl) authBootstrapEl.style.display = 'flex';

  approvalTimer = setInterval(async () => {
    if (gen !== approvalGen) return;
    try {
      const res = await fetch('/api/register/status?username=' + encodeURIComponent(username));
      if (!res.ok || gen !== approvalGen) return;
      const data = await res.json();
      if (data.status === 'pending') return;

      if (data.status === 'approved') {
        authSubmit.textContent = 'Logging in...';
        const loginRes = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        if (gen !== approvalGen) return;
        if (loginRes.ok) {
          stopApprovalWait();
          await completeAuthLogin(await loginRes.json());
        } else {
          stopApprovalWait();
          setAuthMessage('Approved! Please log in with your username and password.', 'info');
          resetAuthSubmitButton();
        }
      } else {
        stopApprovalWait();
        setAuthMessage('Request expired or was declined. Please register again or ask an admin.', 'error');
        resetAuthSubmitButton();
      }
    } catch (_) {}
  }, 4000);
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value.trim();
  setAuthMessage('', '');
  authSubmit.disabled = true;
  authSubmit.textContent = 'Please wait...';

  try {
    const res = await fetch(`/api/${currentAuthTab}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      setAuthMessage(data.error, 'error');
      return;
    }

    if (data.pending) {
      beginApprovalWait(username, password);
      return;
    }

    stopApprovalWait();
    await completeAuthLogin(data);
  } catch (err) {
    setAuthMessage('Connection error', 'error');
  } finally {
    if (authSubmit.disabled && !approvalWait) resetAuthSubmitButton();
  }
});

/* UI State */

(function setupDesktopChangeServer() {
  const T = window.__TAURI__;
  if (!T || !T.core || !T.core.invoke) return;
  const rail = document.getElementById('nav-rail');
  if (!rail) return;
  const btn = document.createElement('button');
  btn.id = 'rail-change-server';
  btn.className = 'rail-item rail-action-item';
  btn.title = 'Change Mellow server';
  btn.innerHTML = '<span class="rail-pill"></span><div class="rail-icon-wrap rail-change-server-text">change<br>server</div>';
  btn.addEventListener('click', () => {
    T.core.invoke('switch_server').catch(() => {});
  });
  rail.insertBefore(btn, rail.firstChild);
})();

function showAuth() {
  authScreen.style.display = 'flex';
  authScreen.classList.remove('hiding');
  app.style.display = 'none';
}

function showApp() {
  authScreen.classList.add('hiding');
  app.style.display = 'flex';
  app.classList.add('showing');
  renderUserInfo();
  updateAdminButtonVisibility();
  setTimeout(() => { authScreen.style.display = 'none'; }, 420);
}

function getDefaultAvatar(identifier) {
  let hash = 0;
  const str = String(identifier || '');
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const num = (Math.abs(hash) % 10) + 1;
  return `/img/avatars/avatar-${num}.svg`;
}

const SAFE_AVATAR_URL_RE = /^\/(img\/avatars\/[a-zA-Z0-9._-]+|uploads\/[a-zA-Z0-9._-]+)$/;
function normalizeAvatarUrl(url, fallbackName) {
  if (typeof url === 'string' && SAFE_AVATAR_URL_RE.test(url)) return url;
  return getDefaultAvatar(fallbackName || '');
}

function getUserAvatarUrl(user) {
  if (currentUser && user && (user.id === currentUser.id || user.userId === currentUser.id) && currentUser.profilePic) {
    return normalizeAvatarUrl(currentUser.profilePic, user.username);
  }
  if (user && user.profilePic) return normalizeAvatarUrl(user.profilePic, user.username || (user.id || user.userId || ''));
  const name = user ? (user.username || user.id || user.userId || '') : '';
  return getDefaultAvatar(name);
}

function getMessageAvatarUrl(message) {
  if (currentUser && message.userId === currentUser.id && currentUser.profilePic) {
    return normalizeAvatarUrl(currentUser.profilePic, message.username);
  }
  const author = allUsersData.find(u => u.id === message.userId);
  if (author && author.profilePic) {
    return normalizeAvatarUrl(author.profilePic, author.username || message.username);
  }
  if (message.profilePic) {
    return normalizeAvatarUrl(message.profilePic, message.username);
  }
  return getDefaultAvatar(message.username || message.userId);
}

function getInitials(name) {
  return name ? name.charAt(0).toUpperCase() : '?';
}

function formatTime(ts) {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* User Info */

function renderUserInfo() {
  userName.textContent = currentUser.username;
  userRoleBadge.textContent = currentUser.role;
  const avatarUrl = getUserAvatarUrl(currentUser);
  userAvatar.innerHTML = `<img src="${avatarUrl}" alt="${escapeHtml(currentUser.username)}">`;

  if (isAdmin(currentUser.role)) {
    if (addChannelBtn) addChannelBtn.style.display = 'flex';
    adminDashboardBtn.style.display = 'flex';
  }

  updateUserStatusDisplay();
}

/* Channels & Categories */

function renderServerRail() {
  if (!railServersList) return;
  railServersList.innerHTML = '';

  if (railAddBtn) {
    railAddBtn.style.display = (currentUser && currentUser.role === 'owner') ? 'flex' : 'none';
  }

  if (servers.length === 0) {
    if (sidebarViewMode === 'channels') {
      setSidebarMode('dms');
    }
    return;
  }

  if (!servers.some(s => s.id === currentServerId)) {
    currentServerId = servers[0].id;
  }

  servers.forEach(server => {
    const btn = document.createElement('button');
    btn.className = 'rail-item' + (server.id === currentServerId && sidebarViewMode === 'channels' ? ' active' : '');
    btn.dataset.serverId = server.id;
    btn.title = server.name;

    const pill = document.createElement('span');
    pill.className = 'rail-pill';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'rail-icon-wrap';

    if (server.icon) {
      iconWrap.innerHTML = `<img src="${escapeHtml(server.icon)}" alt="${escapeHtml(server.name)}" class="rail-logo">`;
    } else {
      const words = server.name.trim().split(/\s+/);
      let initials = '';
      if (words.length >= 2) {
        initials = (words[0][0] + words[1][0]).toUpperCase();
      } else {
        initials = server.name.slice(0, 2).toUpperCase();
      }
      iconWrap.innerHTML = `<span class="server-initials-avatar">${escapeHtml(initials || 'SR')}</span>`;
    }

    btn.appendChild(pill);
    btn.appendChild(iconWrap);

    btn.addEventListener('click', () => {
      switchServer(server.id);
    });

    railServersList.appendChild(btn);
  });

  const currServer = servers.find(s => s.id === currentServerId);
  if (currServer && serverNameLabel) {
    serverNameLabel.textContent = currServer.name;
  }
}

function switchServer(serverId, targetChannelId) {
  currentServerId = serverId;
  const s = servers.find(srv => srv.id === serverId);
  if (s && serverNameLabel) {
    serverNameLabel.textContent = s.name;
  }
  setSidebarMode('channels');
  renderServerRail();
  renderChannels();
  renderOnlineUsers(onlineUsersData);

  const serverChannels = channels.filter(c => c.type !== 'dm' && (c.serverId || 'default-server') === serverId);
  if (serverChannels.length > 0) {
    if (targetChannelId && serverChannels.some(c => c.id === targetChannelId)) {
      switchChannel(targetChannelId);
    } else {
      const isCurrentInServer = serverChannels.some(c => c.id === currentChannelId);
      if (!isCurrentInServer) {
        switchChannel(serverChannels[0].id);
      }
    }
  } else {
    currentChannelId = null;
    if (messagesContainer) messagesContainer.style.display = 'none';
    if (messageInputArea) messageInputArea.style.display = 'none';
    if (currentChannelName) currentChannelName.textContent = 'No channels';
  }
}

function renderCategoriesAndChannels() {
  if (!channelList) return;
  channelList.innerHTML = '';

  if (!currentServerId || servers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-channels-notice';
    empty.style.padding = '24px 16px';
    empty.style.textAlign = 'center';
    empty.style.color = 'var(--text-muted)';
    empty.style.fontSize = '13px';
    empty.innerHTML = `<i class="ph-bold ph-shield-warning" style="font-size:32px;display:block;margin-bottom:8px;opacity:0.6;"></i>You are not in any servers yet.<br><span style="font-size:12px;opacity:0.8;">Ask an Owner or Admin to add you to a server.</span>`;
    channelList.appendChild(empty);
    return;
  }

  const currentServer = servers.find(s => s.id === currentServerId) || {
    id: currentServerId,
    name: 'Mellow',
    categories: [
      { id: 'cat-text', name: 'Text Channels', order: 0 },
      { id: 'cat-voice', name: 'Voice Channels', order: 1 }
    ]
  };

  const isServerOwner = currentUser && (currentServer.ownerId === currentUser.id);
  const canManage = currentUser && (isAdmin(currentUser.role) || isServerOwner);

  let categories = (currentServer.categories && currentServer.categories.length > 0)
    ? [...currentServer.categories]
    : [
        { id: 'cat-text', name: 'Text Channels', order: 0 },
        { id: 'cat-voice', name: 'Voice Channels', order: 1 }
      ];
  categories.sort((a, b) => (a.order || 0) - (b.order || 0));

  const serverChannels = channels
    .filter(c => c.type !== 'dm' && (c.serverId || 'default-server') === currentServerId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  categories.forEach(cat => {
    const catGroup = document.createElement('div');
    const isCollapsed = collapsedCategories.has(cat.id);
    catGroup.className = 'category-group' + (isCollapsed ? ' collapsed' : '');
    catGroup.dataset.categoryId = cat.id;

    const header = document.createElement('div');
    header.className = 'category-header';

    const collapseIcon = document.createElement('span');
    collapseIcon.className = 'category-collapse-icon';
    collapseIcon.innerHTML = '<i class="ph-bold ph-caret-down"></i>';

    const title = document.createElement('span');
    title.className = 'category-title';
    title.textContent = cat.name.toUpperCase();

    header.appendChild(collapseIcon);
    header.appendChild(title);

    if (canManage) {
      const addBtn = document.createElement('button');
      addBtn.className = 'category-add-channel-btn';
      addBtn.title = 'Create Channel';
      addBtn.innerHTML = '<i class="ph ph-plus"></i>';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        targetCategoryIdForNewChannel = cat.id;
        if (channelModal) {
          resetCreateChannelModal();
          channelModal.style.display = 'flex';
          if (channelNameInput) {
            channelNameInput.focus();
          }
        }
      });
      header.appendChild(addBtn);
    }

    header.addEventListener('click', () => {
      if (collapsedCategories.has(cat.id)) {
        collapsedCategories.delete(cat.id);
      } else {
        collapsedCategories.add(cat.id);
      }
      renderCategoriesAndChannels();
    });

    catGroup.appendChild(header);

    if (canManage) {
      catGroup.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      catGroup.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (draggedChannelId) catGroup.classList.add('drag-over');
      });
      catGroup.addEventListener('dragleave', (e) => {
        if (!catGroup.contains(e.relatedTarget)) {
          catGroup.classList.remove('drag-over');
        }
      });
      catGroup.addEventListener('drop', (e) => {
        e.preventDefault();
        catGroup.classList.remove('drag-over');
        if (!draggedChannelId) return;
        const ch = channels.find(c => c.id === draggedChannelId);
        if (!ch) return;
        if (ch.categoryId !== cat.id) {
          ch.categoryId = cat.id;
          sendWS('channel:reorder', { channelId: ch.id, categoryId: cat.id, order: ch.order || 0 });
          renderCategoriesAndChannels();
        }
      });
    }

    const catChannelsDiv = document.createElement('div');
    catChannelsDiv.className = 'category-channels';
    if (isCollapsed) {
      catChannelsDiv.style.display = 'none';
    }

    const categoryChannels = serverChannels.filter(c => {
      if (c.categoryId === cat.id) return true;
      if (!c.categoryId) {
        if (cat.id === 'cat-voice' && c.type === 'voice') return true;
        if (cat.id === 'cat-text' && c.type !== 'voice') return true;
      }
      return false;
    });

    categoryChannels.forEach(ch => {
      const wrap = document.createElement('div');
      wrap.className = 'channel-item-wrap';
      wrap.dataset.channelId = ch.id;

      if (canManage) {
        wrap.draggable = true;
        wrap.addEventListener('dragstart', (e) => {
          draggedChannelId = ch.id;
          wrap.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        wrap.addEventListener('dragend', () => {
          draggedChannelId = null;
          wrap.classList.remove('dragging');
          document.querySelectorAll('.channel-item-wrap.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
        wrap.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        });
        wrap.addEventListener('dragenter', (e) => {
          e.preventDefault();
          if (draggedChannelId && draggedChannelId !== ch.id) {
            wrap.classList.add('drag-over');
          }
        });
        wrap.addEventListener('dragleave', () => {
          wrap.classList.remove('drag-over');
        });
        wrap.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          wrap.classList.remove('drag-over');
          if (!draggedChannelId || draggedChannelId === ch.id) return;
          const fromIdx = serverChannels.findIndex(c => c.id === draggedChannelId);
          const toIdx = serverChannels.findIndex(c => c.id === ch.id);
          if (fromIdx === -1 || toIdx === -1) return;
          const moved = serverChannels.splice(fromIdx, 1)[0];
          serverChannels.splice(toIdx, 0, moved);
          moved.categoryId = cat.id;
          serverChannels.forEach((c, i) => c.order = i);
          sendWS('channel:reorder', { channelId: moved.id, categoryId: cat.id, order: toIdx });
          renderCategoriesAndChannels();
        });
      }

      const el = document.createElement('div');
      el.className = 'channel-item' + (ch.id === currentChannelId ? ' active' : '');
      const isVoice = ch.type === 'voice';
      const icon = isVoice ? '<span class="voice-icon"><i class="ph ph-headphones"></i></span>' : '<span class="hash">#</span>';
      const lockIcon = ch.isPrivate ? '<i class="ph-bold ph-lock-key channel-lock-icon"></i>' : '';
      el.innerHTML = `${icon}${lockIcon}<span class="channel-name">${escapeHtml(ch.name)}</span>`;
      el.onclick = () => switchChannel(ch.id);
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const items = [
          { type: 'header', label: ch.name },
          { label: 'Copy Channel ID', action: () => navigator.clipboard.writeText(ch.id) }
        ];
        if (canManage) {
          items.push({ type: 'divider' });
          items.push({ label: 'Channel Settings', action: () => openChannelSettingsModal(ch) });
          items.push({ label: 'Rename', action: () => renameChannel(ch.id, ch.name) });
          items.push({ label: 'Delete', danger: true, action: () => deleteChannel(ch.id, ch.name) });
        }
        showContextMenu(e.clientX, e.clientY, items);
      });
      wrap.appendChild(el);

      if (isVoice && voiceParticipantsByChannel[ch.id] && voiceParticipantsByChannel[ch.id].length > 0) {
        const participantsDiv = document.createElement('div');
        participantsDiv.className = 'channel-voice-participants';
        const channelSharers = screenSharersByChannel[ch.id] || [];
        voiceParticipantsByChannel[ch.id].forEach(p => {
          const pEl = document.createElement('div');
          pEl.className = 'channel-voice-participant';
          const avatarUrl = getUserAvatarUrl(p);
          const avatarHtml = `<img src="${avatarUrl}" alt="${escapeHtml(p.username)}">`;
          const isSharer = channelSharers.includes(p.userId);
          const liveTag = isSharer ? '<span class="ch-live-tag">LIVE</span>' : '';
          pEl.innerHTML = `<div class="ch-voice-avatar">${avatarHtml}</div><span class="ch-voice-name">${escapeHtml(p.username)}</span>${liveTag}`;
          participantsDiv.appendChild(pEl);
        });
        wrap.appendChild(participantsDiv);
      }

      catChannelsDiv.appendChild(wrap);
    });

    catGroup.appendChild(catChannelsDiv);
    channelList.appendChild(catGroup);
  });
}

function getSortedDmChannels() {
  return (channels || [])
    .filter(c => c.type === 'dm' && !archivedDmIds.includes(c.id))
    .sort((a, b) => {
      const timeA = a.lastMessageAt || a.createdAt || 0;
      const timeB = b.lastMessageAt || b.createdAt || 0;
      return timeB - timeA;
    });
}

function renderDMs() {
  if (!dmList) return;
  dmList.innerHTML = '';
  const dmChannels = getSortedDmChannels();

  dmChannels.forEach(ch => {
    const wrap = document.createElement('div');
    wrap.className = 'dm-item-wrap';
    wrap.dataset.channelId = ch.id;

    const el = document.createElement('div');
    el.className = 'dm-item' + (ch.id === currentChannelId ? ' active' : '');

    const otherUser = ch.dmUser || {};
    const latestUser = allUsersData.find(u => u.id === otherUser.id) || otherUser;
    const avatarUrl = getUserAvatarUrl(latestUser);
    const avatarHtml = `<img src="${avatarUrl}" alt="${escapeHtml(latestUser.username || 'Unknown')}">`;

    el.innerHTML = `<span class="dm-at">@</span>
      <span class="dm-avatar">${avatarHtml}</span>
      <span class="dm-username">${escapeHtml(latestUser.username || otherUser.username || 'Unknown')}</span>`;
    el.onclick = () => switchChannel(ch.id);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [
        { type: 'header', label: latestUser.username || otherUser.username || 'Unknown' }
      ];
      if (otherUser.id && otherUser.id !== currentUser.id) {
        items.push({ label: 'Send DM', action: () => startDM(otherUser.id) });
      }
      items.push({
        label: 'Archive Conversation',
        icon: '<i class="ph ph-archive"></i>',
        action: () => archiveDmConversation(ch.id)
      });
      if (currentUser && currentUser.role === 'owner') {
        items.push({
          label: 'Delete Conversation',
          icon: '<i class="ph ph-trash"></i>',
          danger: true,
          action: () => deleteDmConversation(ch.id)
        });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    wrap.appendChild(el);
    dmList.appendChild(wrap);
  });

  if (dmFilterInput && dmFilterInput.value.trim()) {
    const q = dmFilterInput.value.toLowerCase().trim();
    const items = dmList.querySelectorAll('.dm-item-wrap');
    items.forEach(wrap => {
      const usernameEl = wrap.querySelector('.dm-username');
      const name = (usernameEl ? usernameEl.textContent : '').toLowerCase();
      wrap.style.display = name.includes(q) ? '' : 'none';
    });
  }

  renderUnreadBadges();
}

function renderChannels() {
  renderCategoriesAndChannels();
  renderDMs();

  const regularChannels = channels.filter(c => c.type !== 'dm' && (c.serverId || 'default-server') === currentServerId);
  const dmChannels = getSortedDmChannels();

  if (sidebarViewMode === 'channels' && regularChannels.length > 0 && !currentChannelId) {
    switchChannel(regularChannels[0].id);
  } else if ((sidebarViewMode === 'dms' || regularChannels.length === 0) && dmChannels.length > 0 && !currentChannelId) {
    switchChannel(dmChannels[0].id);
  } else if (!currentChannelId && dmHomeView) {
    showDmHomeView();
  }

  renderUnreadBadges();
}

function switchChannel(channelId) {
  stickToBottom = true;
  closeMobileSidebars();
  closeImageViewer();

  if (typingUsers[currentChannelId]) {
    Object.values(typingUsers[currentChannelId]).forEach(t => clearTimeout(t.timeout));
    delete typingUsers[currentChannelId];
  }
  typingIndicator.style.display = 'none';
  sendTypingStop();
  hideMiniplayer();

  currentChannelId = channelId;
  if (archivedDmIds.includes(channelId)) {
    archivedDmIds = archivedDmIds.filter(id => id !== channelId);
    saveArchivedDms();
    renderDMs();
  }
  unreadCounts[channelId] = 0;
  mentionCounts[channelId] = 0;
  sendWS('channel:read', { channelId });
  document.querySelectorAll('.channel-item,.dm-item').forEach(el => el.classList.remove('active'));
  const activeEl = document.querySelector(`[data-channel-id="${channelId}"]`);
  if (activeEl) {
    const inner = activeEl.querySelector('.channel-item, .dm-item');
    if (inner) inner.classList.add('active');
  } else {
    const regularIdx = channels.filter(c => c.type !== 'dm').findIndex(ch => ch.id === channelId);
    if (regularIdx >= 0) {
      const el = channelList.querySelector(`.channel-item:nth-child(${regularIdx + 1})`);
      if (el) el.classList.add('active');
    } else {
      const dmIdx = getSortedDmChannels().findIndex(ch => ch.id === channelId);
      if (dmIdx >= 0) {
        const el = dmList.querySelector(`.dm-item-wrap:nth-child(${dmIdx + 1}) .dm-item`);
        if (el) el.classList.add('active');
      }
    }
  }

  const ch = channels.find(c => c.id === channelId);
  let chDisplay = 'unknown';
  if (ch) {
    if (ch.type === 'dm') {
      const dmOther = ch.dmUser || {};
      const dmLatest = (allUsersData && allUsersData.find(u => u.id === dmOther.id)) || dmOther;
      chDisplay = `@ ${dmLatest.username || dmOther.username || 'Unknown'}`;
    } else {
      chDisplay = `# ${ch.name}`;
    }
  }
  setChannelNameTitle(ch, chDisplay);

  if (ch && ch.type === 'voice') {
    chatArea.classList.add('voice-chat-layout');
    if (voiceChatOpen) {
      chatArea.classList.remove('chat-collapsed');
      document.querySelectorAll('.vc-chat-toggle-btn').forEach(btn => btn.classList.add('active'));
    } else {
      chatArea.classList.add('chat-collapsed');
      document.querySelectorAll('.vc-chat-toggle-btn').forEach(btn => btn.classList.remove('active'));
    }
    messagesContainer.style.display = 'flex';
    messageInputArea.style.display = 'flex';
    voiceControls.style.display = voiceJoined ? 'flex' : 'none';
    hideFloatingScreenShare();
    pipDismissed = false;

    if (voiceJoined && voiceChannelId === channelId) {
      voiceView.style.display = 'none';
      voiceActiveView.style.display = 'flex';
      voiceScreenArea.style.display = voiceScreenSharing || hasAnyScreenShare() ? 'flex' : 'none';
      setVoiceActiveChannelLabel(ch);
      if (voiceScreenSharing || hasAnyScreenShare()) applyScreenFocus();
    } else {
      voiceView.style.display = 'flex';
      voiceActiveView.style.display = 'none';
      voiceScreenArea.style.display = 'none';
      voiceView.querySelector('.voice-channel-name').textContent = `${ch.name}`;
      updateVoiceParticipantCount(ch.id);
    }
    renderPinnedMessages();
  } else {
    chatArea.classList.remove('voice-chat-layout');
    chatArea.classList.remove('chat-collapsed');
    messagesContainer.style.display = 'flex';
    messageInputArea.style.display = 'flex';
    voiceView.style.display = 'none';

    if (voiceJoined && voiceChannelId === channelId) {
      voiceActiveView.style.display = 'flex';
      voiceControls.style.display = 'flex';
      voiceScreenArea.style.display = voiceScreenSharing || hasAnyScreenShare() ? 'flex' : 'none';
      setVoiceActiveChannelLabel(ch);
      if (voiceScreenSharing || hasAnyScreenShare()) applyScreenFocus();
    } else {
      voiceActiveView.style.display = 'none';
      voiceControls.style.display = 'none';
      voiceScreenArea.style.display = 'none';
      if (voiceScreenSharing || hasAnyScreenShare()) showFloatingScreenShare();
    }
    renderPinnedMessages();
  }

  // Restore regular header & chat area from DM Home if needed
  if (dmHomeView) dmHomeView.style.display = 'none';
  if (dmHomeHeaderTabs) dmHomeHeaderTabs.style.display = 'none';
  if (currentChannelName) currentChannelName.style.display = 'inline-block';
  if (messagesContainer) messagesContainer.style.display = 'flex';
  if (messageInputArea) messageInputArea.style.display = 'flex';
  const pinnedBtn = document.getElementById('pinned-btn');
  if (pinnedBtn) pinnedBtn.style.display = 'inline-flex';
  const searchBtn = document.getElementById('search-btn');
  if (searchBtn) searchBtn.style.display = 'inline-flex';
  const usersToggle = document.getElementById('users-toggle');
  if (usersToggle) usersToggle.style.display = 'inline-flex';

  const dmCallBtn = document.getElementById('dm-call-btn');
  if (dmCallBtn) {
    dmCallBtn.style.display = (ch && ch.type === 'dm') ? 'inline-flex' : 'none';
  }

  if (ch && ch.type === 'voice') {
    messageInput.placeholder = 'Message the call...';
  } else if (ch && ch.type === 'dm') {
    const dmOther = ch.dmUser || {};
    const dmLatest = (allUsersData && allUsersData.find(u => u.id === dmOther.id)) || dmOther;
    messageInput.placeholder = `Message @${dmLatest.username || dmOther.username || 'user'}`;
  } else if (ch) {
    messageInput.placeholder = `Message #${ch.name}`;
  }

  // Update Mellow rail and adaptive sidebar views
  if (ch && ch.type === 'dm') {
    if (dmBackBtn) dmBackBtn.style.display = 'inline-flex';
    sidebarViewMode = 'dms';
    if (railDmBtn) railDmBtn.classList.add('active');
    if (railServerBtn) railServerBtn.classList.remove('active');
    document.querySelectorAll('#rail-servers-list .rail-item').forEach(b => b.classList.remove('active'));
    if (sidebarDmsView) sidebarDmsView.style.display = 'flex';
    if (sidebarChannelsView) sidebarChannelsView.style.display = 'none';
    if (channelMembersView) channelMembersView.style.display = 'none';
    if (dmProfileCard) dmProfileCard.style.display = 'flex';
    if (usersSidebar) usersSidebar.style.display = 'none';
    updateDmProfileCard(ch.dmUser);
  } else {
    if (dmBackBtn) dmBackBtn.style.display = 'none';
    sidebarViewMode = 'channels';
    if (ch && ch.serverId) currentServerId = ch.serverId;
    if (railServerBtn) railServerBtn.classList.add('active');
    if (railDmBtn) railDmBtn.classList.remove('active');
    document.querySelectorAll('#rail-servers-list .rail-item').forEach(b => {
      b.classList.toggle('active', b.dataset.serverId === currentServerId);
    });
    const isVoiceChannel = !!(ch && ch.type === 'voice');
    if (sidebarChannelsView) sidebarChannelsView.style.display = 'flex';
    if (sidebarDmsView) sidebarDmsView.style.display = 'none';
    if (dmProfileCard) dmProfileCard.style.display = 'none';
    if (channelMembersView) channelMembersView.style.display = 'flex';
    if (usersSidebar) usersSidebar.style.display = isVoiceChannel ? 'none' : '';
    if (usersToggle) usersToggle.style.display = isVoiceChannel ? 'none' : 'inline-flex';
    renderOnlineUsers(onlineUsersData);
  }

  sendWS('channel:join', { channelId });
}

function setChannelNameTitle(ch, fallbackText) {
  if (!currentChannelName) return;
  if (ch && ch.type === 'voice') {
    currentChannelName.innerHTML = `<i class="ph-bold ph-speaker-high"></i> ${escapeHtml(ch.name)}`;
  } else {
    currentChannelName.textContent = fallbackText;
  }
}

function setVoiceActiveChannelLabel(ch) {
  const label = document.querySelector('#voice-active-header .voice-channel-label');
  if (!label) return;
  if (ch && ch.type === 'dm') {
    label.textContent = ch.dmUser ? `@${ch.dmUser.username}` : '@DM Call';
  } else {
    label.innerHTML = `<i class="ph-bold ph-speaker-high"></i> ${escapeHtml(ch ? ch.name : '')}`;
  }
}

function setSidebarMode(mode) {
  sidebarViewMode = mode;
  if (mode === 'dms') {
    if (railDmBtn) railDmBtn.classList.add('active');
    if (railServerBtn) railServerBtn.classList.remove('active');
    document.querySelectorAll('#rail-servers-list .rail-item').forEach(b => b.classList.remove('active'));
    if (sidebarDmsView) sidebarDmsView.style.display = 'flex';
    if (sidebarChannelsView) sidebarChannelsView.style.display = 'none';

    const currentCh = channels.find(c => c.id === currentChannelId);
    if (!currentCh || currentCh.type !== 'dm') {
      showDmHomeView();
    }
  } else {
    if (railServerBtn) railServerBtn.classList.add('active');
    if (railDmBtn) railDmBtn.classList.remove('active');
    document.querySelectorAll('#rail-servers-list .rail-item').forEach(b => {
      b.classList.toggle('active', b.dataset.serverId === currentServerId);
    });
    if (sidebarChannelsView) sidebarChannelsView.style.display = 'flex';
    if (sidebarDmsView) sidebarDmsView.style.display = 'none';

    const currentCh = channels.find(c => c.id === currentChannelId);
    if (!currentCh || currentCh.type === 'dm' || (currentCh.serverId && currentCh.serverId !== currentServerId)) {
      const serverChannels = channels.filter(c => c.type !== 'dm' && (c.serverId || 'default-server') === currentServerId);
      if (serverChannels.length > 0) {
        switchChannel(serverChannels[0].id);
      } else {
        if (dmProfileCard) dmProfileCard.style.display = 'none';
        if (channelMembersView) channelMembersView.style.display = 'flex';
        renderOnlineUsers(onlineUsersData);
      }
    }
  }
}

function updateDmProfileCard(dmUser) {
  if (!dmProfileCard) return;
  const user = (allUsersData && allUsersData.find(u => u.id === (dmUser && dmUser.id))) || dmUser || {};
  if (dmProfileAvatar) {
    dmProfileAvatar.src = getUserAvatarUrl(user);
    dmProfileAvatar.alt = user.username || 'User';
  }
  if (dmProfileStatusDot) {
    const status = user.status || 'offline';
    dmProfileStatusDot.className = `user-status-dot ${status}`;
  }
  if (dmProfileName) {
    dmProfileName.textContent = user.username || 'Unknown';
  }
  if (dmProfileTag) {
    dmProfileTag.textContent = user.role === 'admin' ? 'Admin' : 'Member';
  }
  if (dmProfileStatusText) {
    const custom = user.customStatus ? `“${user.customStatus}”` : (user.status ? user.status.toUpperCase() : 'ONLINE');
    dmProfileStatusText.textContent = custom;
  }
  if (dmProfileBioText) {
    dmProfileBioText.textContent = user.aboutMe || '';
  }
}

function showDmHomeView() {
  currentChannelId = null;
  closeMobileSidebars();

  // Unselect channels and DMs
  document.querySelectorAll('.channel-item, .dm-item-wrap').forEach(el => el.classList.remove('active'));

  // Header adjustments
  if (currentChannelName) currentChannelName.style.display = 'none';
  if (dmBackBtn) dmBackBtn.style.display = 'none';
  if (dmHomeHeaderTabs) dmHomeHeaderTabs.style.display = 'flex';
  const dmCallBtn = document.getElementById('dm-call-btn');
  if (dmCallBtn) dmCallBtn.style.display = 'none';
  const pinnedBtn = document.getElementById('pinned-btn');
  if (pinnedBtn) pinnedBtn.style.display = 'none';
  const searchBtn = document.getElementById('search-btn');
  if (searchBtn) searchBtn.style.display = 'none';
  const usersToggle = document.getElementById('users-toggle');
  if (usersToggle) usersToggle.style.display = 'none';

  // Main area adjustments
  if (messagesContainer) messagesContainer.style.display = 'none';
  if (messageInputArea) messageInputArea.style.display = 'none';
  const voiceView = document.getElementById('voice-view');
  if (voiceView) voiceView.style.display = 'none';
  if (dmHomeView) dmHomeView.style.display = 'flex';

  // Right sidebar adjustments (hide during DM Home)
  if (dmProfileCard) dmProfileCard.style.display = 'none';
  if (channelMembersView) channelMembersView.style.display = 'none';
  if (usersSidebar) usersSidebar.style.display = 'none';

  // Navigation rail & left sidebar
  sidebarViewMode = 'dms';
  if (railDmBtn) railDmBtn.classList.add('active');
  if (railServerBtn) railServerBtn.classList.remove('active');
  document.querySelectorAll('#rail-servers-list .rail-item').forEach(b => b.classList.remove('active'));
  if (sidebarDmsView) sidebarDmsView.style.display = 'flex';
  if (sidebarChannelsView) sidebarChannelsView.style.display = 'none';

  // Leaving the voice view for DM Home: tear down voice panels (the squashed
  // strip bug) and move any visible stream into the floating PiP window.
  if (voiceActiveView) voiceActiveView.style.display = 'none';
  if (voiceControls) voiceControls.style.display = 'none';
  chatArea.classList.remove('voice-chat-layout');
  chatArea.classList.remove('chat-collapsed');
  if (voiceScreenSharing || hasAnyScreenShare()) showFloatingScreenShare();

  renderDmHomeMembers();
}

function renderDmHomeMembers() {
  if (!dmHomeMembersList) return;
  dmHomeMembersList.innerHTML = '';

  const query = (dmHomeSearchInput ? dmHomeSearchInput.value : '').trim().toLowerCase();

  const currentUserId = currentUser ? currentUser.id : null;
  const otherUsers = (allUsersData || []).filter(u => u.id !== currentUserId && !u.isDeleted);

  const onlineUserIds = new Set((onlineUsersData || []).map(u => u.id));

  let filtered = otherUsers.filter(u => {
    const isOnline = onlineUserIds.has(u.id);
    if (dmHomeFilter === 'online' && !isOnline) return false;
    if (query && !u.username.toLowerCase().includes(query)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const aOnline = onlineUserIds.has(a.id);
    const bOnline = onlineUserIds.has(b.id);
    if (aOnline && !bOnline) return -1;
    if (!aOnline && bOnline) return 1;
    return a.username.localeCompare(b.username);
  });

  if (dmHomeSectionTitle) {
    const label = dmHomeFilter === 'online' ? 'Online' : 'All Members';
    dmHomeSectionTitle.innerHTML = `${label} &mdash; ${filtered.length}`;
  }

  if (filtered.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'dm-home-empty';
    emptyDiv.innerHTML = `
      <div class="dm-home-empty-icon"><i class="ph ph-users"></i></div>
      <div class="dm-home-empty-title">No members found</div>
      <div class="dm-home-empty-desc">${dmHomeFilter === 'online' ? 'No one is online right now on this LAN.' : 'No other members have registered yet.'}</div>
    `;
    dmHomeMembersList.appendChild(emptyDiv);
    return;
  }

  filtered.forEach(u => {
    const isOnline = onlineUserIds.has(u.id);
    const onlineData = (onlineUsersData || []).find(ou => ou.id === u.id);
    const status = isOnline ? ((onlineData && onlineData.status) || u.status || 'online') : 'offline';
    const customStatus = (onlineData && onlineData.customStatus) || u.customStatus || '';

    const row = document.createElement('div');
    row.className = 'dm-home-member-row';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'dm-home-member-info';

    const avatarUrl = getUserAvatarUrl(u);
    const statusDotClass = `user-status-dot ${status}`;

    let statusText = isOnline ? (status === 'dnd' ? 'Do Not Disturb' : status.charAt(0).toUpperCase() + status.slice(1)) : 'Offline';
    if (customStatus) {
      statusText = customStatus;
    }

    const role = (u.role || 'user').toLowerCase();
    const roleBadge = (role === 'admin' || role === 'owner')
      ? `<span class="role-badge ${role}">${role.toUpperCase()}</span>`
      : '';

    infoDiv.innerHTML = `
      <div class="popover-avatar-wrap" style="position:relative;width:40px;height:40px;flex-shrink:0;">
        <img src="${avatarUrl}" alt="${escapeHtml(u.username)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">
        <span class="${statusDotClass}"></span>
      </div>
      <div class="dm-home-member-details">
        <div class="dm-home-member-name-row">
          <span class="dm-home-member-name">${escapeHtml(u.username)}</span>
          ${roleBadge}
        </div>
        <div class="dm-home-member-status-text" title="${escapeHtml(statusText)}">${escapeHtml(statusText)}</div>
      </div>
    `;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'dm-home-member-actions';

    const chatBtn = document.createElement('button');
    chatBtn.className = 'dm-home-action-btn';
    chatBtn.title = `Message @${escapeHtml(u.username)}`;
    chatBtn.innerHTML = '<i class="ph-bold ph-chat-circle-dots"></i>';
    chatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startDM(u.id);
    });

    const moreBtn = document.createElement('button');
    moreBtn.className = 'dm-home-action-btn';
    moreBtn.title = 'View Profile';
    moreBtn.innerHTML = '<i class="ph-bold ph-dots-three-vertical"></i>';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showUserProfilePopover(u.id, moreBtn);
    });

    actionsDiv.appendChild(chatBtn);
    actionsDiv.appendChild(moreBtn);

    row.appendChild(infoDiv);
    row.appendChild(actionsDiv);

    row.addEventListener('click', () => {
      startDM(u.id);
    });

    dmHomeMembersList.appendChild(row);
  });
}

function updateVoiceParticipantCount(channelId) {
  const count = (voiceParticipantsByChannel[channelId] || []).length;
  document.querySelectorAll('.voice-participant-count').forEach(el => {
    el.textContent = count > 0 ? String(count) : '';
  });
}

/* Messages */

function createChannelStartBanner(channel) {
  const banner = document.createElement('div');
  banner.className = 'channel-start-banner';
  const isDM = channel.type === 'dm';
  const icon = isDM ? '<i class="ph-bold ph-at"></i>' : '<i class="ph-bold ph-hash"></i>';
  const title = isDM ? (channel.dmUser ? channel.dmUser.username : 'Direct Message') : channel.name;
  const subtitle = isDM
    ? `This is the beginning of your direct message history with ${escapeHtml(title)}.`
    : `Welcome to the start of the #${escapeHtml(title)} channel!`;
  banner.innerHTML = `
    <div class="channel-start-icon">${icon}</div>
    <h3 class="channel-start-title">Welcome to ${isDM ? '' : '#'}${escapeHtml(title)}!</h3>
    <p class="channel-start-subtitle">${subtitle}</p>
  `;
  return banner;
}

function renderMessages(channelId, messages) {
  if (channelId !== currentChannelId) return;
  const previousLastRead = lastReadByChannel[channelId] || 0;
  stickToBottom = true;
  messagesContainer.innerHTML = '';
  currentMessages = [...messages];

  const ch = channels.find(c => c.id === channelId);
  if (ch) {
    messagesContainer.appendChild(createChannelStartBanner(ch));
  }

  messages.forEach(msg => appendMessageDOM(msg));
  unreadCounts[channelId] = 0;
  renderUnreadBadges();

  let firstUnreadEl = null;
  for (const el of messagesContainer.querySelectorAll('.message[data-timestamp]')) {
    if (Number(el.getAttribute('data-timestamp')) > previousLastRead && el.dataset.userId !== currentUser.id) {
      firstUnreadEl = el;
      break;
    }
  }

  if (firstUnreadEl) {
    insertNewMessagesDivider(firstUnreadEl);
  }
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    lastReadByChannel[channelId] = lastMsg.timestamp;
    sendWS('channel:read', { channelId });
  }
  scrollToBottom();
  updateJumpButtons();

  [50, 150, 300, 600].forEach(delay => {
    setTimeout(() => {
      if (stickToBottom && currentChannelId === channelId) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        updateJumpButtons();
      }
    }, delay);
  });
}

function insertNewMessagesDivider(firstUnreadEl) {
  const existing = messagesContainer.querySelector('.new-messages-divider');
  if (existing) existing.remove();
  const divider = document.createElement('div');
  divider.className = 'new-messages-divider';
  divider.innerHTML = '<span>New Messages</span>';
  firstUnreadEl.parentNode.insertBefore(divider, firstUnreadEl);
}

function findFirstUnreadEl() {
  if (!currentChannelId) return null;
  const lastRead = lastReadByChannel[currentChannelId] || 0;
  for (const el of messagesContainer.querySelectorAll('.message[data-timestamp]')) {
    if (Number(el.getAttribute('data-timestamp')) > lastRead && el.dataset.userId !== currentUser.id) {
      return el;
    }
  }
  return null;
}

function shouldHideJumpButtons() {
  return Boolean(voiceView && voiceView.style.display !== 'none' && !voiceChatOpen);
}

function updateJumpButtons() {
  if (shouldHideJumpButtons()) {
    if (jumpToUnreadBtn) jumpToUnreadBtn.style.display = 'none';
    if (jumpToPresentBtn) jumpToPresentBtn.style.display = 'none';
    return;
  }
  const firstUnread = findFirstUnreadEl();
  if (firstUnread) {
    const containerRect = messagesContainer.getBoundingClientRect();
    const rect = firstUnread.getBoundingClientRect();
    const outOfView = rect.top < containerRect.top - 20 || rect.bottom > containerRect.bottom + 20;
    jumpToUnreadBtn.style.display = outOfView ? 'flex' : 'none';
  } else {
    jumpToUnreadBtn.style.display = 'none';
  }
}

function scrollToMessage(el) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'start' });
      updateJumpButtons();
    });
  });
}

function isUnreadMsg(message, channelId) {
  return message.userId !== currentUser.id && message.timestamp > (lastReadByChannel[channelId] || 0);
}

function isNearBottom() {
  return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;
}

function addMessage(channelId, message) {
  if (channelId === currentChannelId) {
    const empty = messagesContainer.querySelector('.empty-state');
    if (empty) empty.remove();
    currentMessages.push(message);
    appendMessageDOM(message);
    if (isNearBottom() || stickToBottom) {
      lastReadByChannel[channelId] = message.timestamp;
      sendWS('channel:read', { channelId });
      scrollToBottom();
    }
    updateJumpButtons();
  } else if (isUnreadMsg(message, channelId)) {
    if (!unreadCounts[channelId]) unreadCounts[channelId] = 0;
    unreadCounts[channelId]++;
    renderUnreadBadges();
  }
}

function removeMessage(channelId, messageId) {
  if (channelId !== currentChannelId) return;
  currentMessages = currentMessages.filter(m => m.id !== messageId);
  const el = document.getElementById(`msg-${messageId}`);
  if (el) el.remove();
}

function handleMessageEdited(data) {
  const msg = currentMessages.find(m => m.id === data.messageId);
  if (msg) {
    msg.text = data.text;
    msg.editedAt = data.editedAt;
  }
  const el = document.getElementById(`msg-${data.messageId}`);
  if (!el) return;
  const textEl = el.querySelector('.message-text');
  if (textEl) {
    textEl.innerHTML = renderMessageContent(data.text);
    Embed.initEmbeds(el);
  }
  const header = el.querySelector('.message-header');
  if (header && !header.querySelector('.message-edited')) {
    const span = document.createElement('span');
    span.className = 'message-edited';
    span.textContent = '(edited)';
    header.appendChild(span);
  } else if (!header && textEl && !textEl.querySelector('.message-edited')) {
    const span = document.createElement('span');
    span.className = 'message-edited';
    span.textContent = ' (edited)';
    textEl.appendChild(span);
  }
}

function startReply(messageId) {
  const msg = currentMessages.find(m => m.id === messageId);
  if (!msg) return;
  activeReply = {
    id: msg.id,
    username: msg.username,
    text: msg.text || (msg.files && msg.files.length ? `[${msg.files.length} file(s)]` : '')
  };
  const bar = document.getElementById('reply-bar');
  const userSpan = document.getElementById('reply-bar-user');
  const snippetSpan = document.getElementById('reply-bar-snippet');
  if (bar && userSpan && snippetSpan) {
    userSpan.textContent = activeReply.username;
    snippetSpan.textContent = activeReply.text.slice(0, 60);
    bar.style.display = 'flex';
  }
  messageInput.focus();
}

function cancelReply() {
  activeReply = null;
  const bar = document.getElementById('reply-bar');
  if (bar) bar.style.display = 'none';
}

function startInlineEdit(messageId) {
  if (editingMessageId) {
    cancelInlineEdit(editingMessageId);
  }
  const el = document.getElementById(`msg-${messageId}`);
  if (!el) return;
  const msg = currentMessages.find(m => m.id === messageId);
  if (!msg || msg.userId !== currentUser.id) return;

  const contentEl = el.querySelector('.message-content');
  const textEl = el.querySelector('.message-text');
  if (!contentEl) return;

  editingMessageId = messageId;
  el.classList.add('is-editing');

  const editBox = document.createElement('div');
  editBox.className = 'message-inline-edit-box';
  editBox.innerHTML = `
    <textarea class="edit-textarea">${escapeHtml(msg.text || '')}</textarea>
    <div class="edit-help">
      escape to <a href="javascript:void(0)" class="edit-cancel">cancel</a> • enter to <a href="javascript:void(0)" class="edit-save">save</a>
    </div>
  `;

  if (textEl) textEl.style.display = 'none';
  contentEl.insertBefore(editBox, textEl ? textEl.nextSibling : contentEl.firstChild);

  const textarea = editBox.querySelector('textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  };
  textarea.addEventListener('input', resize);
  resize();

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveInlineEdit(messageId, textarea.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelInlineEdit(messageId);
    }
  });

  editBox.querySelector('.edit-cancel').addEventListener('click', () => cancelInlineEdit(messageId));
  editBox.querySelector('.edit-save').addEventListener('click', () => saveInlineEdit(messageId, textarea.value));
}

function cancelInlineEdit(messageId) {
  const el = document.getElementById(`msg-${messageId}`);
  if (el) {
    el.classList.remove('is-editing');
    const editBox = el.querySelector('.message-inline-edit-box');
    if (editBox) editBox.remove();
    const textEl = el.querySelector('.message-text');
    if (textEl) textEl.style.display = '';
  }
  if (editingMessageId === messageId) editingMessageId = null;
}

async function saveInlineEdit(messageId, newText) {
  const trimmed = newText.trim();
  const msg = currentMessages.find(m => m.id === messageId);
  if (!trimmed && (!msg.files || msg.files.length === 0)) {
    if (await showConfirmModal({
      title: 'Delete Message',
      message: 'Delete this message?',
      confirmText: 'Delete',
      danger: true
    })) {
      deleteMessage(messageId);
    }
    cancelInlineEdit(messageId);
    return;
  }
  sendWS('message:edit', {
    channelId: currentChannelId,
    messageId,
    text: trimmed
  });
  cancelInlineEdit(messageId);
}

function shouldGroupMessage(message) {
  if (message.replyTo) return false;
  const lastMsgEl = messagesContainer.lastElementChild;
  if (!lastMsgEl || !lastMsgEl.classList.contains('message')) return false;
  const lastUserId = lastMsgEl.dataset.userId;
  const lastTimestamp = Number(lastMsgEl.dataset.timestamp);
  if (!lastUserId || !lastTimestamp) return false;
  if (lastUserId !== message.userId) return false;
  const timeDiff = Math.abs(message.timestamp - lastTimestamp);
  return timeDiff < 5 * 60 * 1000;
}

function appendMessageDOM(message) {
  const isGrouped = shouldGroupMessage(message);
  const isOwn = message.userId === currentUser.id;
  const div = document.createElement('div');
  div.className = 'message' + (isGrouped ? ' grouped' : '') + (isOwn ? ' own' : '');
  div.id = `msg-${message.id}`;
  div.dataset.userId = message.userId;
  div.dataset.timestamp = message.timestamp;

  const author = allUsersData.find(u => u.id === message.userId);
  const displayUsername = (author && author.username) ? author.username : (message.username || 'Unknown');

  const avatarUrl = getMessageAvatarUrl(message);
  const avatarHtml = `<img src="${avatarUrl}" alt="${escapeHtml(displayUsername)}">`;

  let replyHtml = '';
  if (message.replyTo) {
    const replyAuthor = allUsersData.find(u => u.id === message.replyTo.userId);
    const replyUsername = (replyAuthor && replyAuthor.username) ? replyAuthor.username : (message.replyTo.username || 'Unknown');
    replyHtml = `<div class="message-reply-preview" onclick="jumpToMessage('${message.replyTo.id}')">
      <i class="ph ph-arrow-bend-up-left reply-icon"></i>
      <span class="reply-user">@${escapeHtml(replyUsername)}</span>
      <span class="reply-text">${escapeHtml(message.replyTo.text || '...')}</span>
    </div>`;
  }

  let headerHtml = '';
  if (!isGrouped) {
    headerHtml = `<div class="message-header">
      <span class="message-username" data-user-id="${message.userId}" onclick="typeof showUserProfilePopover === 'function' && showUserProfilePopover('${message.userId}', this)">${escapeHtml(displayUsername)}</span>
      <span class="message-timestamp">${formatTime(message.timestamp)}</span>
      ${message.editedAt ? '<span class="message-edited">(edited)</span>' : ''}
    </div>`;
  }

  let bodyHtml = '';
  if (message.text) {
    bodyHtml += `<div class="message-text">${renderMessageContent(message.text)}${isGrouped && message.editedAt ? ' <span class="message-edited">(edited)</span>' : ''}</div>`;
  }

  if (message.files && message.files.length) {
    message.files.forEach(f => {
      bodyHtml += renderFileAttachment(f);
    });
  } else if (message.file) {
    bodyHtml += renderFileAttachment(message.file);
  }

  const deleteBtn = (isAdmin(currentUser.role) || isOwn)
    ? `<button class="message-delete-btn" onclick="deleteMessage('${message.id}')" title="Delete message">&times;</button>`
    : '';

  const editBtn = isOwn
    ? `<button class="message-edit-btn" onclick="startInlineEdit('${message.id}')" title="Edit message"><i class="ph ph-pencil-simple"></i></button>`
    : '';

  const replyBtn = `<button class="reply-btn" onclick="startReply('${message.id}')" title="Reply"><i class="ph ph-arrow-bend-up-left"></i></button>`;

  const currentCh = (channels || []).find(c => c.id === currentChannelId);
  const isPinned = currentCh && currentCh.pinned && currentCh.pinned.some(p => p.messageId === message.id);
  const pinBtn = isAdmin(currentUser.role)
    ? `<button class="pin-btn ${isPinned ? 'pinned' : ''}" onclick="togglePinMessage('${message.id}')" title="${isPinned ? 'Unpin message' : 'Pin message'}"><i class="ph ph-pin"></i></button>`
    : '';

  const reactBtn = `<button class="react-btn" onclick="showReactionPicker(event, '${message.id}')" title="Add reaction"><i class="ph ph-smiley"></i></button>`;

  const leftGutterHtml = isGrouped
    ? `<div class="message-gutter"><span class="message-timestamp-hover">${formatTime(message.timestamp)}</span></div>`
    : `<div class="message-avatar" data-user-id="${message.userId}" onclick="typeof showUserProfilePopover === 'function' && showUserProfilePopover('${message.userId}', this)">${avatarHtml}</div>`;

  const bubbleClass = isOwn ? 'outgoing' : 'incoming';
  div.innerHTML = `${leftGutterHtml}
    <div class="message-content">${replyHtml}${headerHtml}<div class="message-bubble ${bubbleClass}">${bodyHtml}</div>
      <div class="message-reactions" id="reactions-${message.id}"></div>
    </div>
    <div class="message-actions">
      ${reactBtn}
      ${replyBtn}
      ${editBtn}
      ${pinBtn}
      ${deleteBtn}
    </div>`;

  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isAuthor = message.userId === currentUser.id;
    const items = [
      {
        label: 'Add Reaction',
        action: () => showReactionPicker(e, message.id)
      },
      {
        label: 'Reply',
        action: () => startReply(message.id)
      }
    ];

    if (message.text) {
      items.push({
        label: 'Copy Text',
        action: () => navigator.clipboard.writeText(message.text)
      });
    }

    if (isAuthor) {
      items.push({
        label: 'Edit Message',
        action: () => startInlineEdit(message.id)
      });
    }

    if (isAdmin(currentUser.role)) {
      const ch = channels.find(c => c.id === currentChannelId);
      const isPinned = ch && ch.pinned && ch.pinned.some(p => p.messageId === message.id);
      items.push({
        label: isPinned ? 'Unpin Message' : 'Pin Message',
        action: () => togglePinMessage(message.id)
      });
    }

    if (isAuthor || isAdmin(currentUser.role)) {
      items.push({ type: 'divider' });
      items.push({
        label: 'Delete Message',
        danger: true,
        action: () => deleteMessage(message.id)
      });
    }

    showContextMenu(e.clientX, e.clientY, items);
  });

  messagesContainer.appendChild(div);
  Embed.initEmbeds(div);

  if (message.reactions && Object.keys(message.reactions).length > 0) {
    const reactionsDiv = div.querySelector('.message-reactions');
    renderReactions(reactionsDiv, message.id, message.reactions);
  }
}

function renderFileAttachment(file) {
  const isImage = (file.type && file.type.startsWith('image/')) || /\.svg$/i.test(file.name || '');
  const isVideo = file.type && file.type.startsWith('video/');
  const isAudio = (file.type && file.type.startsWith('audio/')) || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name || '');
  const isExecutable = /\.(exe|bat|cmd|msi|scr|com)$/i.test(file.name || '');

  if (isImage) {
    return `<div class="message-text"><img src="${file.url}" alt="${escapeHtml(file.name)}" loading="lazy"></div>`;
  }

  if (isVideo) {
    return `<div class="message-text"><video src="${file.url}" controls preload="metadata"></video></div>`;
  }

  if (isAudio) {
    return `<div class="message-audio">
      <audio controls preload="metadata" src="${file.url}"></audio>
      <span class="audio-filename">${escapeHtml(file.name)}</span>
    </div>`;
  }

  if (isExecutable) {
    return `<a href="${file.url}" download="${escapeHtml(file.name)}" onclick="handleExecutableDownload(event, '${file.url}', '${escapeHtml(file.name)}')" class="file-attachment file-executable" title="Executable file">
      <div class="file-icon"><i class="ph ph-warning-circle" style="color: var(--danger, #ef4444); font-size: 20px;"></i></div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="file-size">${formatSize(file.size)} &bull; Executable</div>
      </div>
    </a>`;
  }

  const fileIcon = '\uD83D\uDCC4';
  return `<a href="${file.url}" download="${escapeHtml(file.name)}" target="_blank" class="file-attachment">
    <div class="file-icon">${fileIcon}</div>
    <div class="file-info">
      <div class="file-name">${escapeHtml(file.name)}</div>
      <div class="file-size">${formatSize(file.size)}</div>
    </div>
  </a>`;
}

async function handleExecutableDownload(e, url, name) {
  e.preventDefault();
  e.stopPropagation();
  const confirmed = await showConfirmModal({
    title: 'Executable File Warning',
    message: `"${name}" is an executable program (.exe). Running programs from untrusted sources can harm your computer. Do you want to download it anyway?`,
    confirmText: 'Download',
    danger: true
  });
  if (confirmed) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'download.exe';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

function isAdmin(role) {
  return role === 'admin' || role === 'owner';
}

/* Image Viewer */

function openImageViewer(src, alt) {
  imageViewerImg.src = src;
  imageViewerImg.alt = alt || '';
  imageViewer.style.display = 'flex';
}

function closeImageViewer() {
  imageViewer.style.display = 'none';
  imageViewerImg.src = '';
}

imageViewer.addEventListener('click', (e) => {
  if (e.target === imageViewer) closeImageViewer();
});
imageViewerCloseBtn.addEventListener('click', closeImageViewer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && imageViewer.style.display !== 'none') closeImageViewer();
});

messagesContainer.addEventListener('click', (e) => {
  const img = e.target.closest('.message-text img');
  if (!img) return;
  if (img.classList.contains('embed-thumb')) return;
  openImageViewer(img.src, img.alt);
});

function escapeHtml(text) {
  if (typeof TextFormat !== 'undefined' && TextFormat.escapeHtml) {
    return TextFormat.escapeHtml(text);
  }
  return String(text || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c] || c));
}

function scrollToBottom() {
  stickToBottom = true;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    requestAnimationFrame(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      updateJumpButtons();
    });
  });
}

/* Unread tracking */

function updateTotalUnreadTitle() {
  const totalUnread = Object.values(unreadCounts).reduce((sum, c) => sum + (c || 0), 0) +
                      Object.values(mentionCounts).reduce((sum, c) => sum + (c || 0), 0);
  if (totalUnread > 0) {
    document.title = `(${totalUnread > 99 ? '99+' : totalUnread}) Mellow`;
  } else {
    document.title = 'Mellow';
  }
}

function renderUnreadBadges() {
  document.querySelectorAll('.channel-item-wrap').forEach(wrap => {
    const chId = wrap.dataset.channelId;
    const chEl = wrap.querySelector('.channel-item');
    if (!chEl) return;

    // Clean up any legacy misplaced badge directly on wrap
    const misplaced = wrap.querySelector(':scope > .unread-badge');
    if (misplaced) misplaced.remove();

    let badge = chEl.querySelector('.unread-badge');
    const count = unreadCounts[chId] || 0;
    const mentions = mentionCounts[chId] || 0;
    const total = count + mentions;
    const displayCount = mentions > 0 ? mentions : count;

    if (total > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge';
        chEl.appendChild(badge);
      }
      badge.textContent = displayCount > 99 ? '99+' : displayCount;
      badge.className = 'unread-badge' + (mentions > 0 ? ' mention' : '');
      badge.onclick = (e) => {
        e.stopPropagation();
        jumpToFirstUnread(chId);
      };
      chEl.classList.add('has-unread');
    } else {
      if (badge) badge.remove();
      chEl.classList.remove('has-unread');
    }
  });

  document.querySelectorAll('.dm-item-wrap').forEach(wrap => {
    const chId = wrap.dataset.channelId;
    const dmEl = wrap.querySelector('.dm-item');
    if (!dmEl) return;

    // Clean up any legacy misplaced badge directly on wrap
    const misplaced = wrap.querySelector(':scope > .unread-badge');
    if (misplaced) misplaced.remove();

    let badge = dmEl.querySelector('.unread-badge');
    const count = unreadCounts[chId] || 0;
    const mentions = mentionCounts[chId] || 0;
    const total = count + mentions;
    const displayCount = mentions > 0 ? mentions : count;

    if (total > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge';
        dmEl.appendChild(badge);
      }
      badge.textContent = displayCount > 99 ? '99+' : displayCount;
      badge.className = 'unread-badge' + (mentions > 0 ? ' mention' : '');
      badge.onclick = (e) => {
        e.stopPropagation();
        jumpToFirstUnread(chId);
      };
      dmEl.classList.add('has-unread');
    } else {
      if (badge) badge.remove();
      dmEl.classList.remove('has-unread');
    }
  });

  // Rail badge: DM unread count on #rail-dm-btn
  if (typeof document !== 'undefined' && railDmBtn) {
    const dmChannels = channels.filter(c => c.type === 'dm');
    let totalDmUnread = 0;
    dmChannels.forEach(ch => {
      totalDmUnread += (unreadCounts[ch.id] || 0) + (mentionCounts[ch.id] || 0);
    });
    let railBadge = railDmBtn.querySelector('.rail-badge');
    if (totalDmUnread > 0) {
      if (!railBadge) {
        railBadge = document.createElement('span');
        railBadge.className = 'rail-badge';
        railDmBtn.appendChild(railBadge);
      }
      railBadge.textContent = totalDmUnread > 99 ? '99+' : totalDmUnread;
    } else if (railBadge) {
      railBadge.remove();
    }
  }

  // Rail badge: per-server unread count on each server rail item
  if (typeof document !== 'undefined') {
    document.querySelectorAll('#rail-servers-list .rail-item').forEach(btn => {
      const serverId = btn.dataset.serverId;
      if (!serverId) return;
      const serverChannels = channels.filter(c => c.type !== 'dm' && (c.serverId || 'default-server') === serverId);
      let serverUnread = 0;
      serverChannels.forEach(ch => {
        serverUnread += (unreadCounts[ch.id] || 0) + (mentionCounts[ch.id] || 0);
      });
      let srvBadge = btn.querySelector('.rail-badge');
      if (serverUnread > 0) {
        if (!srvBadge) {
          srvBadge = document.createElement('span');
          srvBadge.className = 'rail-badge';
          btn.appendChild(srvBadge);
        }
        srvBadge.textContent = serverUnread > 99 ? '99+' : serverUnread;
      } else if (srvBadge) {
        srvBadge.remove();
      }
    });
  }

  updateTotalUnreadTitle();
}

function jumpToFirstUnread(channelId) {
  switchChannel(channelId);
}

function jumpToPresent() {
  stickToBottom = true;
  scrollToBottom();
  jumpToPresentBtn.style.display = 'none';
  updateJumpButtons();
}

jumpToPresentBtn.addEventListener('click', jumpToPresent);

jumpToUnreadBtn.addEventListener('click', () => {
  const el = findFirstUnreadEl();
  if (el) {
    scrollToMessage(el);
    el.classList.add('message-highlight-flash');
    setTimeout(() => el.classList.remove('message-highlight-flash'), 2000);
    updateJumpButtons();
  }
});

messagesContainer.addEventListener('scroll', () => {
  if (shouldHideJumpButtons()) {
    jumpToPresentBtn.style.display = 'none';
    if (jumpToUnreadBtn) jumpToUnreadBtn.style.display = 'none';
    return;
  }
  const atBottom = isNearBottom();
  stickToBottom = atBottom;
  jumpToPresentBtn.style.display = atBottom ? 'none' : 'flex';
  if (atBottom && currentChannelId) {
    unreadCounts[currentChannelId] = 0;
    lastReadByChannel[currentChannelId] = Date.now();
    sendWS('channel:read', { channelId: currentChannelId });
    renderUnreadBadges();
  }
  updateJumpButtons();
});

messagesContainer.addEventListener('load', () => {
  if (stickToBottom) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}, true);

messagesContainer.addEventListener('loadedmetadata', () => {
  if (stickToBottom) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}, true);

if (typeof ResizeObserver !== 'undefined' && messagesContainer) {
  const messageResizeObserver = new ResizeObserver(() => {
    if (stickToBottom) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  });
  messageResizeObserver.observe(messagesContainer);
}

/* Send Message */

let mentionSearchActive = false;
let mentionSearchQuery = '';
let mentionSearchStart = 0;
let mentionSelectedIdx = 0;

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
  if (mentionSearchActive) {
    const items = mentionDropdown.querySelectorAll('.mention-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionSelectedIdx = Math.min(mentionSelectedIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('selected', i === mentionSelectedIdx));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionSelectedIdx = Math.max(mentionSelectedIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('selected', i === mentionSelectedIdx));
      return;
    }
    if (e.key === 'Enter' && items.length > 0) {
      e.preventDefault();
      selectMention(items[mentionSelectedIdx].dataset.username);
      return;
    }
    if (e.key === 'Escape') {
      mentionSearchActive = false;
      mentionDropdown.style.display = 'none';
      return;
    }
  }
  if (e.key === 'ArrowUp' && !mentionSearchActive && messageInput.value === '') {
    e.preventDefault();
    const myLastMsg = [...currentMessages].reverse().find(m => m.userId === currentUser.id && m.text);
    if (myLastMsg) {
      startInlineEdit(myLastMsg.id);
    }
    return;
  }
  if (e.key === 'Escape' && activeReply) {
    cancelReply();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  requestAnimationFrame(autoResize);
});
const replyBarClose = document.getElementById('reply-bar-close');
if (replyBarClose) {
  replyBarClose.addEventListener('click', cancelReply);
}
messageInput.addEventListener('input', autoResize);
messageInput.addEventListener('input', handleMentionInput);
messageInput.addEventListener('focus', () => {
  autoResize();
  setTimeout(() => messageInput.scrollIntoView({ block: 'nearest' }), 300);
});

document.addEventListener('click', (e) => {
  if (mentionSearchActive && !mentionDropdown.contains(e.target) && e.target !== messageInput) {
    mentionSearchActive = false;
    mentionDropdown.style.display = 'none';
  }
});

function autoResize() {
  messageInput.style.height = 'auto';
  const h = Math.min(messageInput.scrollHeight, 120);
  messageInput.style.height = h + 'px';
}

function handleMentionInput() {
  const val = messageInput.value;
  const cursorPos = messageInput.selectionStart;
  const textBefore = val.substring(0, cursorPos);
  const atMatch = textBefore.match(/@(\w*)$/);
  if (atMatch) {
    mentionSearchActive = true;
    mentionSearchQuery = atMatch[1].toLowerCase();
    mentionSearchStart = cursorPos - atMatch[0].length;
    let matches = allUsersData.filter(u => !u.isDeleted && u.username.toLowerCase().includes(mentionSearchQuery));
    if (isAdmin(currentUser.role)) {
      matches.unshift({ id: '__everyone__', username: 'everyone', role: 'everyone' });
    }
    if (matches.length > 0) {
      mentionSelectedIdx = 0;
      mentionDropdown.innerHTML = matches.map((u, i) => {
        const avatarHtml = u.role === 'everyone'
          ? '@'
          : `<img src="${getUserAvatarUrl(u)}" alt="${escapeHtml(u.username)}">`;
        const label = u.role === 'everyone' ? '@everyone' : `@${escapeHtml(u.username)}`;
        return `<div class="mention-item${i === 0 ? ' selected' : ''}" data-username="${u.role === 'everyone' ? '@everyone' : escapeHtml(u.username)}" data-is-everyone="${u.role === 'everyone'}">
          <div class="mention-avatar">${avatarHtml}</div>
          <span>${label}</span>
        </div>`;
      }).join('');
      mentionDropdown.style.display = 'block';
      mentionDropdown.querySelectorAll('.mention-item').forEach(el => {
        el.addEventListener('click', () => selectMention(el.dataset.username));
      });
    } else {
      mentionDropdown.style.display = 'none';
      mentionSearchActive = false;
    }
  } else {
    mentionSearchActive = false;
    mentionDropdown.style.display = 'none';
  }
}

function selectMention(username) {
  const val = messageInput.value;
  const before = val.substring(0, mentionSearchStart);
  const after = val.substring(messageInput.selectionStart);
  const insert = username === '@everyone' ? '@everyone ' : `@${username} `;
  messageInput.value = before + insert + after;
  messageInput.selectionStart = messageInput.selectionEnd = mentionSearchStart + insert.length;
  messageInput.focus();
  mentionSearchActive = false;
  mentionDropdown.style.display = 'none';
}

function renderMessageContent(text) {
  if (!text) return '';
  let html = '';
  for (const token of TextFormat.tokenizeMessage(text)) {
    if (token.type === 'text') {
      let t = escapeHtml(token.text);
      t = TextFormat.formatMarkdown(t);
      t = t.replace(/@everyone/g, '<span class="mention highlight-everyone">@everyone</span>');
      allUsersData.forEach(u => {
        const safeName = TextFormat.escapeRegex(escapeHtml(u.username));
        const regex = new RegExp(`@${safeName}\\b`, 'g');
        t = t.replace(regex, `<span class="mention highlight-user">@${escapeHtml(u.username)}</span>`);
      });
      html += t;
    } else {
      const safeUrl = escapeHtml(token.url);
      const link = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
      if (token.provider) {
        html += `<span class="embed-slot" data-provider="${escapeHtml(token.provider)}" data-id="${escapeHtml(token.videoId || '')}" data-media-type="${escapeHtml(token.mediaType || '')}" data-url="${safeUrl}">${link}</span>`;
      } else {
        html += link;
      }
    }
  }
  return html;
}

function jumpToMessage(targetChannelIdOrMessageId, optionalMessageId) {
  let targetChannelId = null;
  let messageId = null;

  if (optionalMessageId) {
    targetChannelId = targetChannelIdOrMessageId;
    messageId = optionalMessageId;
  } else {
    messageId = targetChannelIdOrMessageId;
  }

  if (targetChannelId && targetChannelId !== currentChannelId) {
    switchChannel(targetChannelId);
  }

  closeSearchModal();
  closePinnedDrawer();

  const delay = targetChannelId && targetChannelId !== currentChannelId ? 220 : 40;
  setTimeout(() => {
    const el = document.getElementById(`msg-${messageId}`) || document.querySelector(`.message[data-message-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('search-highlight');
      el.classList.remove('message-highlight-flash');
      void el.offsetWidth;
      el.classList.add('search-highlight');
      setTimeout(() => el.classList.remove('search-highlight'), 2500);
    }
  }, delay);
}

async function renameChannel(channelId, currentName) {
  const name = await showPromptModal({
    title: 'Rename Channel',
    message: 'Enter a new channel name:',
    defaultValue: currentName,
    placeholder: 'channel-name'
  });
  if (name && name.trim() && name.trim() !== currentName) {
    sendWS('channel:rename', { channelId, name: name.trim() });
  }
}

async function deleteChannel(channelId, name) {
  if (await showConfirmModal({
    title: 'Delete Channel',
    message: `Delete #${name}?`,
    confirmText: 'Delete',
    danger: true
  })) {
    sendWS('channel:delete', { channelId });
  }
}

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text && selectedFiles.length === 0) return;

  let files = null;

  if (selectedFiles.length > 0) {
    files = [];
    for (const file of selectedFiles) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { Authorization: token },
          body: formData
        });
        if (!res.ok) {
          await showAlertModal({ title: 'Upload Failed', message: `Upload failed for ${file.name}`, type: 'danger' });
          return;
        }
        const data = await res.json();
        files.push({ url: data.url, name: data.name, size: data.size, type: data.type });
      } catch (err) {
        console.error('Upload failed:', err);
        await showAlertModal({ title: 'Upload Failed', message: `Upload failed for ${file.name}`, type: 'danger' });
        return;
      }
    }
  }

  const mentions = [];
  if (text.includes('@everyone')) {
    mentions.push('everyone');
  }
  onlineUsersData.forEach(u => {
    if (u.id !== currentUser.id && text.includes(`@${u.username}`)) {
      mentions.push(u.id);
    }
  });

  const payload = { text, files, mentions };
  if (activeReply) {
    payload.replyToId = activeReply.id;
    cancelReply();
  }

  sendWS('message:send', payload);
  const currentCh = channels.find(c => c.id === currentChannelId);
  if (currentCh && currentCh.type === 'dm') {
    currentCh.lastMessageAt = Date.now();
    if (archivedDmIds.includes(currentCh.id)) {
      archivedDmIds = archivedDmIds.filter(id => id !== currentCh.id);
      saveArchivedDms();
    }
    renderDMs();
  }
  sendTypingStop();
  messageInput.value = '';
  messageInput.style.height = 'auto';
  clearFileQueue();
}

async function deleteMessage(messageId) {
  if (await showConfirmModal({
    title: 'Delete Message',
    message: 'Delete this message?',
    confirmText: 'Delete',
    danger: true
  })) {
    sendWS('message:delete', { channelId: currentChannelId, messageId });
  }
}

/* File Upload */

const MAX_ATTACHMENTS = 8;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

fileBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    addFilesToQueue(fileInput.files);
    fileInput.value = '';
  }
});

/* Drag & drop with Chat Overlay */

function isFileDragEvent(e) {
  if (!e || !e.dataTransfer) return false;
  const dt = e.dataTransfer;
  if (dt.files && dt.files.length > 0) return true;
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      if (dt.items[i].kind === 'file') return true;
    }
  }
  if (dt.types) {
    const types = Array.from(dt.types);
    return types.some(t => t && (t.toLowerCase() === 'files' || t === 'Files'));
  }
  return false;
}

function showDragOverlayIfActive() {
  if (!currentUser || !currentChannelId || !chatDragOverlay) return;
  const ch = channels.find(c => c.id === currentChannelId);
  if (chatDragChannelName && ch) {
    chatDragChannelName.textContent = ch.type === 'dm'
      ? `@${(ch.dmUser || {}).username || 'Direct Message'}`
      : `#${ch.name}`;
  }
  chatDragOverlay.style.display = 'flex';
}

function hideDragOverlay() {
  chatDragCounter = 0;
  if (chatDragOverlay) chatDragOverlay.style.display = 'none';
}

window.addEventListener('dragenter', (e) => {
  if (!currentUser || !currentChannelId) return;
  if (isFileDragEvent(e)) {
    e.preventDefault();
    chatDragCounter++;
    showDragOverlayIfActive();
  }
});

window.addEventListener('dragover', (e) => {
  if (isFileDragEvent(e)) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
});

window.addEventListener('dragleave', (e) => {
  chatDragCounter--;
  if (chatDragCounter <= 0 || !e.relatedTarget || (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)) {
    hideDragOverlay();
  }
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  hideDragOverlay();
  if (!currentUser || !currentChannelId) return;
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    addFilesToQueue(e.dataTransfer.files);
  }
});

if (chatDragOverlay) {
  chatDragOverlay.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  chatDragOverlay.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideDragOverlay();
  });

  chatDragOverlay.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideDragOverlay();
    if (!currentUser || !currentChannelId) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  });
}

if (messageInputArea) {
  messageInputArea.addEventListener('dragover', (e) => {
    if (isFileDragEvent(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
  });

  messageInputArea.addEventListener('drop', (e) => {
    if (isFileDragEvent(e)) {
      e.preventDefault();
      e.stopPropagation();
      hideDragOverlay();
      if (!currentUser || !currentChannelId) return;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        addFilesToQueue(e.dataTransfer.files);
      }
    }
  });
}

/* Clipboard Image Paste (Ctrl+V) */
window.addEventListener('paste', (e) => {
  const active = document.activeElement;
  if (active && (
    active.id === 'settings-username' ||
    active.id === 'settings-password' ||
    active.id === 'channel-name-input' ||
    active.id === 'quick-switcher-input'
  )) {
    return;
  }
  if (!currentUser || !currentChannelId) return;

  if (e.clipboardData && e.clipboardData.items) {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map((item, idx) => {
        const blob = item.getAsFile();
        if (!blob) return null;
        const ext = (blob.type.split('/')[1] || 'png').replace('e-stream', 'png');
        const filename = `screenshot-${new Date().toISOString().slice(0, 10)}-${Date.now()}-${idx + 1}.${ext}`;
        return new File([blob], filename, { type: blob.type });
      }).filter(Boolean);
      if (files.length > 0) {
        addFilesToQueue(files);
      }
    }
  }
});

function addFilesToQueue(fileList) {
  const files = Array.from(fileList);
  const oversizedFiles = [];
  let limitReached = false;

  for (const file of files) {
    if (selectedFiles.length >= MAX_ATTACHMENTS) {
      limitReached = true;
      break;
    }
    if (file.size > MAX_FILE_SIZE) {
      oversizedFiles.push(file.name);
      continue;
    }
    selectedFiles.push(file);
  }

  if (oversizedFiles.length > 0) {
    const verb = oversizedFiles.length > 1 ? 'exceed' : 'exceeds';
    const wasWere = oversizedFiles.length > 1 ? 'were' : 'was';
    showAlertModal({
      title: 'File Too Large',
      message: `${oversizedFiles.join(', ')} ${verb} the 50 MB limit and ${wasWere} not attached.`,
      type: 'warning'
    });
  } else if (limitReached) {
    showAlertModal({
      title: 'Attachment Limit',
      message: `Maximum ${MAX_ATTACHMENTS} attachments per message.`,
      type: 'warning'
    });
  }

  renderFileChips();
}

function renderFileChips() {
  fileChips.innerHTML = '';
  selectedFiles.forEach((file, index) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    const icon = file.type && file.type.startsWith('image/') ? '\uD83D\uDDBC'
      : file.type && file.type.startsWith('video/') ? '\uD83C\uDFAC' : '\uD83D\uDCC4';
    chip.innerHTML = `<span class="file-chip-icon">${icon}</span>
      <span class="file-chip-name">${escapeHtml(file.name)}</span>
      <span class="file-chip-size">${formatSize(file.size)}</span>
      <button class="file-chip-remove" title="Remove">&times;</button>`;
    chip.querySelector('.file-chip-remove').addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      renderFileChips();
    });
    fileChips.appendChild(chip);
  });
}

function clearFileQueue() {
  selectedFiles = [];
  fileChips.innerHTML = '';
}

/* Online Users */

function renderOnlineUsers(users) {
  onlineUsersData = users;
  userList.innerHTML = '';

  const currentServer = (sidebarViewMode === 'channels') ? servers.find(s => s.id === currentServerId) : null;
  const isServerMember = (u) => {
    if (!u || u.isDeleted) return false;
    if (!currentServer) return true;
    return currentServer.ownerId === u.id || (Array.isArray(currentServer.members) && currentServer.members.includes(u.id));
  };

  const filteredOnline = (users || []).filter(u => !u.isDeleted && isServerMember(u));
  onlineCount.textContent = filteredOnline.length;

  const onlineIds = new Set(filteredOnline.map(u => u.id));

  filteredOnline.forEach(u => {
    userList.appendChild(createUserListItem(u, true));
  });

  const offlineUsers = (allUsersData || []).filter(u => !u.isDeleted && u.id !== (currentUser && currentUser.id) && !onlineIds.has(u.id) && isServerMember(u));
  offlineUserList.innerHTML = '';
  offlineCount.textContent = offlineUsers.length;

  offlineUsers.forEach(u => {
    offlineUserList.appendChild(createUserListItem(u, false));
  });

  if (serverAddMembersSidebarBtn) {
    const isServerOwner = currentUser && currentServer && currentServer.ownerId === currentUser.id;
    const canManage = currentUser && (isAdmin(currentUser.role) || isServerOwner);
    serverAddMembersSidebarBtn.style.display = (sidebarViewMode === 'channels' && currentServer && canManage) ? 'inline-flex' : 'none';
  }

  if (dmHomeView && dmHomeView.style.display !== 'none') {
    renderDmHomeMembers();
  }
}

function renderMembersList(users) {
  return renderOnlineUsers(users || onlineUsersData);
}

function createUserListItem(u, isOnline) {
  const div = document.createElement('div');
  div.className = 'user-list-item' + (u.id !== currentUser.id ? ' clickable' : '') + (!isOnline ? ' offline' : '');
  div.id = `user-${u.id}`;

  const avatarUrl = getUserAvatarUrl(u);
  const avatarHtml = `<img src="${avatarUrl}" alt="${escapeHtml(u.username)}">`;

  const roleTag = u.role === 'admin' ? '<span class="user-role-tag">Admin</span>' : u.role === 'owner' ? '<span class="user-role-tag owner">Owner</span>' : '';
  const kickBtn = currentUser && isAdmin(currentUser.role) && u.role !== 'owner' && (u.role !== 'admin' || currentUser.role === 'owner')
    ? `<button class="kick-btn" onclick="event.stopPropagation(); kickUser('${u.id}')">Kick</button>`
    : '';

  const status = isOnline ? (u.status || 'online') : 'offline';
  const dotClass = isOnline ? `online-dot ${status}` : 'online-dot offline';
  const customStatusHtml = (isOnline && u.customStatus) ? `<span class="user-custom-status" title="${escapeHtml(u.customStatus)}">${escapeHtml(u.customStatus)}</span>` : '';

  div.innerHTML = `<div class="${dotClass}"></div>
    <div class="user-avatar">${avatarHtml}</div>
    <div class="user-panel-details" style="flex:1;">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="user-name">${escapeHtml(u.username)}</span>
        ${roleTag}
      </div>
      ${customStatusHtml}
    </div>
    ${kickBtn}`;

  div.addEventListener('click', (e) => {
    e.stopPropagation();
    showUserProfilePopover(u.id, div);
  });

  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [
      { type: 'profile', username: u.username, profilePic: getUserAvatarUrl(u), role: u.role },
      { type: 'divider' }
    ];
    if (u.id !== currentUser.id) {
      items.push({ label: 'Send DM', action: () => startDM(u.id) });
    }

    const currentServer = servers.find(s => s.id === currentServerId);
    const canManageServer = currentUser && (isAdmin(currentUser.role) || (currentServer && currentServer.ownerId === currentUser.id));
    if (currentServer && canManageServer && u.id !== currentUser.id) {
      const isMember = Array.isArray(currentServer.members) && currentServer.members.includes(u.id);
      const isServerOwner = currentServer.ownerId === u.id;
      if (!isMember) {
        items.push({
          label: `Add to ${currentServer.name}`,
          action: () => sendWS('server:member:add', { serverId: currentServer.id, userId: u.id })
        });
      } else if (!isServerOwner) {
        items.push({
          label: `Remove from ${currentServer.name}`,
          danger: true,
          action: () => sendWS('server:member:remove', { serverId: currentServer.id, userId: u.id })
        });
      }
    }

    items.push({ type: 'header', label: 'Role: ' + (u.role || 'user') });
    showContextMenu(e.clientX, e.clientY, items);
  });

  return div;
}

async function kickUser(userId) {
  if (await showConfirmModal({
    title: 'Kick User',
    message: 'Kick this user? Their account will be deleted.',
    confirmText: 'Kick',
    danger: true
  })) {
    sendWS('user:kick', { userId });
  }
}

function startDM(userId) {
  sendWS('dm:create', { targetUserId: userId });
}

/* Settings / Profile Pic */

/* Logout */

document.getElementById('logout-btn').addEventListener('click', async () => {
  if (await showConfirmModal({
    title: 'Logout',
    message: 'Are you sure you want to log out of Mellow?',
    confirmText: 'Logout',
    danger: false
  })) {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { Authorization: token } });
    } catch (_) {}
    localStorage.removeItem('token');
    wsAuthenticated = false;
    leaveVoiceChannel(true);
    if (ws) ws.close();
    location.reload();
  }
});

/* Admin Dashboard */

const adminDashboardBtn = document.getElementById('admin-dashboard-btn');
const adminModal = document.getElementById('admin-modal');
const adminUserList = document.getElementById('admin-user-list');

function renderAdminUsers(users) {
  adminUserList.innerHTML = '';
  const activeUsers = (users || []).filter(u => !u.isDeleted);
  activeUsers.forEach(u => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';
    row.id = `admin-user-${u.id}`;

    const avatarUrl = getUserAvatarUrl(u);
    const avatarHtml = `<img src="${avatarUrl}" alt="${escapeHtml(u.username)}">`;

    const roleTag = `<span class="admin-user-role${u.role === 'owner' ? ' owner' : ''}">${u.role}</span>`;

    let actionsHtml = '';
    if (u.id !== currentUser.id) {
      const isOwner = currentUser.role === 'owner';
      const canManageTarget = isOwner ? (u.role !== 'owner') : (u.role === 'user');

      if (canManageTarget) {
        actionsHtml += `<button class="admin-rename-btn" onclick="adminRenameUser('${u.id}')">Rename</button>`;
      }
      if (isOwner && u.role !== 'owner') {
        if (u.role === 'admin') {
          actionsHtml += `<button class="admin-rename-btn" onclick="setUserRole('${u.id}', 'user')">Remove Admin</button>`;
        } else {
          actionsHtml += `<button class="admin-rename-btn" onclick="setUserRole('${u.id}', 'admin')">Make Admin</button>`;
        }
      }
      if (canManageTarget) {
        actionsHtml += `<button class="admin-delete-btn" onclick="adminDeleteUser('${u.id}')">Delete</button>`;
      }
    }

    row.innerHTML = `
      <div class="user-avatar">${avatarHtml}</div>
      <span class="admin-user-name">${escapeHtml(u.username)}</span>
      ${roleTag}
      <div class="admin-user-actions">${actionsHtml}</div>
    `;
    adminUserList.appendChild(row);
  });
}

async function setUserRole(userId, role) {
  if (await showConfirmModal({
    title: 'Change Role',
    message: `Change this user's role to ${role}?`,
    confirmText: 'Change Role',
    danger: false
  })) {
    sendWS('user:setrole', { targetUserId: userId, role });
    setTimeout(loadAdminUsers, 500);
  }
}

async function loadAdminUsers() {
  try {
    const res = await fetch('/api/users', { headers: { Authorization: token } });
    if (res.ok) {
      const data = await res.json();
      const activeUsers = (data.users || []).filter(u => !u.isDeleted);
      renderAdminUsers(activeUsers);
    }
  } catch (e) {
    console.error('Failed to load users:', e);
  }
}

function loadPendingRegistrations() {
  sendWS('admin:registration:list', {});
}

function renderAdminPendingRequests(requests) {
  const listEl = document.getElementById('admin-pending-list');
  const countEl = document.getElementById('admin-pending-count');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (countEl) {
    countEl.textContent = String(requests.length);
    countEl.style.display = requests.length > 0 ? '' : 'none';
  }
  if (!requests || requests.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pending-empty';
    empty.textContent = 'No pending requests';
    listEl.appendChild(empty);
    return;
  }
  const now = Date.now();
  requests.forEach(req => {
    const row = document.createElement('div');
    row.className = 'pending-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'pending-username';
    nameEl.textContent = req.username;
    const minsLeft = Math.max(0, Math.ceil(((req.expiresAt || 0) - now) / 60000));
    const timeEl = document.createElement('span');
    timeEl.className = 'pending-time';
    timeEl.textContent = minsLeft + 'm left';
    const approveBtn = document.createElement('button');
    approveBtn.className = 'pending-approve-btn';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', () => approveRegistrationRequest(req.username));
    const denyBtn = document.createElement('button');
    denyBtn.className = 'pending-deny-btn';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', () => denyRegistrationRequest(req.username));
    row.appendChild(nameEl);
    row.appendChild(timeEl);
    row.appendChild(approveBtn);
    row.appendChild(denyBtn);
    listEl.appendChild(row);
  });
}

function approveRegistrationRequest(username) {
  sendWS('admin:registration:approve', { username });
}

async function denyRegistrationRequest(username) {
  if (await showConfirmModal({
    title: 'Deny Registration',
    message: `Deny the registration request from "${username}"?`,
    confirmText: 'Deny',
    danger: true
  })) {
    sendWS('admin:registration:deny', { username });
  }
}

async function adminRenameUser(userId) {
  const newName = await showPromptModal({
    title: 'Rename User',
    message: 'New username:',
    placeholder: 'username'
  });
  if (newName && newName.trim().length >= 2) {
    sendWS('user:update', { targetUserId: userId, username: newName.trim() });
    setTimeout(loadAdminUsers, 500);
  }
}

async function adminDeleteUser(userId) {
  if (await showConfirmModal({
    title: 'Delete User',
    message: 'Delete this user permanently?',
    confirmText: 'Delete',
    danger: true
  })) {
    sendWS('user:kick', { userId });
    const row = document.getElementById(`admin-user-${userId}`);
    if (row) row.remove();
  }
}

adminDashboardBtn.addEventListener('click', () => {
  loadAdminUsers();
  loadPendingRegistrations();
  adminModal.style.display = 'flex';
});

// DM sidebar admin button (admin/owner only)
const dmAdminDashboardBtn = document.getElementById('dm-admin-dashboard-btn');

function updateAdminButtonVisibility() {
  const show = currentUser && isAdmin(currentUser.role);
  if (dmAdminDashboardBtn) dmAdminDashboardBtn.style.display = show ? 'inline-flex' : 'none';
}

if (dmAdminDashboardBtn) {
  dmAdminDashboardBtn.addEventListener('click', () => {
    loadAdminUsers();
    loadPendingRegistrations();
    adminModal.style.display = 'flex';
  });
}

adminModal.addEventListener('click', (e) => {
  if (e.target === adminModal) adminModal.style.display = 'none';
});

/* Mobile sidebar toggles */

const sidebarToggle = document.getElementById('sidebar-toggle');
const usersToggle = document.getElementById('users-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const usersOverlay = document.getElementById('users-overlay');
const sidebar = document.getElementById('sidebar');
const usersSidebar = document.getElementById('users-sidebar');

const navRail = document.getElementById('nav-rail');

function closeMobileSidebars() {
  sidebar.classList.remove('open');
  if (navRail) navRail.classList.remove('open');
  usersSidebar.classList.remove('open');
  sidebarOverlay.classList.remove('active');
  usersOverlay.classList.remove('active');
}

sidebarToggle.addEventListener('click', () => {
  const isOpen = sidebar.classList.toggle('open');
  if (navRail) navRail.classList.toggle('open', isOpen);
  sidebarOverlay.classList.toggle('active', isOpen);
  usersSidebar.classList.remove('open');
  usersOverlay.classList.remove('active');
});

usersToggle.addEventListener('click', () => {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    const isOpen = usersSidebar.classList.toggle('open');
    usersOverlay.classList.toggle('active', isOpen);
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('active');
  } else {
    const isCollapsed = usersSidebar.classList.toggle('collapsed');
    usersToggle.classList.toggle('active', !isCollapsed);
    usersOverlay.classList.remove('active');
  }
});

sidebarOverlay.addEventListener('click', closeMobileSidebars);
usersOverlay.addEventListener('click', closeMobileSidebars);

window.addEventListener('resize', () => {
  if (window.innerWidth > 768) {
    if (sidebarOverlay) sidebarOverlay.classList.remove('active');
    if (usersOverlay) usersOverlay.classList.remove('active');
    if (sidebar) sidebar.classList.remove('open');
    if (usersSidebar) usersSidebar.classList.remove('open');
  }
});

function openSettingsModal() {
  settingsModal.style.display = 'flex';
  const picUrl = getUserAvatarUrl(currentUser);
  settingsProfilePic.src = picUrl;
  settingsProfilePic.style.display = 'block';

  const aboutMeInput = document.getElementById('settings-aboutme');
  if (aboutMeInput) {
    aboutMeInput.value = currentUser ? (currentUser.aboutMe || '') : '';
  }

  const currentSetting = getNotificationSetting();
  const radio = document.querySelector(`input[name="notification-setting"][value="${currentSetting}"]`);
  if (radio) radio.checked = true;

  populateAudioDevices(true);
}

document.querySelectorAll('input[name="notification-setting"]').forEach(input => {
  input.addEventListener('change', (e) => {
    if (e.target.checked) {
      setNotificationSetting(e.target.value);
    }
  });
});

if (settingsBtn) {
  settingsBtn.addEventListener('click', openSettingsModal);
}

// Mellow Navigation Rail & Adaptive View Listeners
if (railDmBtn) {
  railDmBtn.addEventListener('click', () => {
    setSidebarMode('dms');
    showDmHomeView();
  });
}

if (dmBackBtn) {
  dmBackBtn.addEventListener('click', () => {
    showDmHomeView();
  });
}

if (dmHomeSearchInput) {
  dmHomeSearchInput.addEventListener('input', () => {
    renderDmHomeMembers();
  });
}

document.querySelectorAll('.dm-home-filter-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.dm-home-filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    dmHomeFilter = tab.dataset.filter || 'online';
    renderDmHomeMembers();
  });
});

if (railServerBtn) {
  railServerBtn.addEventListener('click', () => setSidebarMode('channels'));
}

if (railAddBtn) {
  railAddBtn.addEventListener('click', () => {
    if (createServerModal) {
      if (createServerName) createServerName.value = '';
      if (createServerError) createServerError.textContent = '';
      createServerSelectedIcon = '/img/server-icons/icon-1.svg';
      if (createServerIconPreview) createServerIconPreview.src = createServerSelectedIcon;
      document.querySelectorAll('#create-server-premade-icons .premade-icon-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.icon === createServerSelectedIcon);
      });
      createServerModal.style.display = 'flex';
      setTimeout(() => {
        if (createServerName) createServerName.focus();
      }, 50);
    }
  });
}

document.querySelectorAll('#create-server-premade-icons .premade-icon-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#create-server-premade-icons .premade-icon-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    createServerSelectedIcon = btn.dataset.icon;
    if (createServerIconPreview) createServerIconPreview.src = createServerSelectedIcon;
  });
});

if (createServerUploadBtn && createServerIconFile) {
  createServerUploadBtn.addEventListener('click', () => createServerIconFile.click());
  createServerIconFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: localStorage.getItem('token') },
        body: formData
      });
      const data = await res.json();
      if (data.url) {
        createServerSelectedIcon = data.url;
        if (createServerIconPreview) createServerIconPreview.src = data.url;
        document.querySelectorAll('#create-server-premade-icons .premade-icon-btn').forEach(b => b.classList.remove('active'));
      }
    } catch (err) {
      console.error('Server icon upload failed:', err);
    }
  });
}

function closeServerDropdown() {
  if (serverDropdownMenu) serverDropdownMenu.style.display = 'none';
  if (serverHeaderDropdownTrigger) serverHeaderDropdownTrigger.classList.remove('open');
}

// Server Header Dropdown Menu
if (serverHeaderDropdownTrigger) {
  serverHeaderDropdownTrigger.addEventListener('click', (e) => {
    if (e.target.closest('#admin-dashboard-btn') || e.target.closest('#logout-btn')) {
      return;
    }
    const currentServer = servers.find(s => s.id === currentServerId);
    const isDefaultServer = currentServer && currentServer.id === 'default-server';
    const isServerOwner = currentUser && currentServer && currentServer.ownerId === currentUser.id;
    const canManage = currentUser && (isAdmin(currentUser.role) || isServerOwner);
    if (!canManage) return;

    if (serverMenuDelete) {
      serverMenuDelete.style.display = (!isDefaultServer && (isServerOwner || isAdmin(currentUser.role))) ? 'flex' : 'none';
    }
    const divider = document.getElementById('server-menu-divider-manage');
    if (divider) {
      divider.style.display = canManage ? 'block' : 'none';
    }
    if (serverMenuSettings) {
      serverMenuSettings.style.display = canManage ? 'flex' : 'none';
    }

    if (serverDropdownMenu) {
      const isVisible = serverDropdownMenu.style.display === 'block';
      serverDropdownMenu.style.display = isVisible ? 'none' : 'block';
      serverHeaderDropdownTrigger.classList.toggle('open', !isVisible);
    }
  });
}

document.addEventListener('click', (e) => {
  if (serverDropdownMenu && serverDropdownMenu.style.display === 'block') {
    if (!serverDropdownMenu.contains(e.target) && !serverHeaderDropdownTrigger.contains(e.target)) {
      closeServerDropdown();
    }
  }
});

if (serverMenuAddChannel) {
  serverMenuAddChannel.addEventListener('click', () => {
    closeServerDropdown();
    targetCategoryIdForNewChannel = null;
    if (channelModal) {
      resetCreateChannelModal();
      channelModal.style.display = 'flex';
      setTimeout(() => channelNameInput.focus(), 100);
    }
  });
}

if (serverMenuAddCategory) {
  serverMenuAddCategory.addEventListener('click', () => {
    closeServerDropdown();
    if (createCategoryModal) {
      if (createCategoryName) createCategoryName.value = '';
      if (createCategoryError) createCategoryError.textContent = '';
      createCategoryModal.style.display = 'flex';
      setTimeout(() => {
        if (createCategoryName) createCategoryName.focus();
      }, 100);
    }
  });
}

function openServerMembersModal() {
  const currentServer = servers.find(s => s.id === currentServerId);
  if (!currentServer || !serverMembersModal) return;
  if (serverMembersModalTitle) {
    serverMembersModalTitle.textContent = `${currentServer.name} - Members`;
  }
  if (serverMembersList) {
    renderServerMembersModal();
    serverMembersModal.style.display = 'flex';
  }
}

if (serverMenuMembers) {
  serverMenuMembers.addEventListener('click', () => {
    closeServerDropdown();
    openServerMembersModal();
  });
}

if (serverAddMembersSidebarBtn) {
  serverAddMembersSidebarBtn.addEventListener('click', openServerMembersModal);
}

function openServerSettingsModal() {
  const currentServer = servers.find(s => s.id === currentServerId);
  if (!currentServer || !serverSettingsModal) return;

  if (editServerName) editServerName.value = currentServer.name || '';
  if (editServerError) editServerError.textContent = '';
  editServerSelectedIcon = currentServer.icon || '/img/server-icons/icon-1.svg';
  if (editServerIconPreview) editServerIconPreview.src = editServerSelectedIcon;

  document.querySelectorAll('#edit-server-premade-icons .premade-icon-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.icon === editServerSelectedIcon);
  });

  const isDefaultServer = currentServer.id === 'default-server';
  const dangerSection = document.getElementById('server-settings-danger-section');
  if (dangerSection) {
    dangerSection.style.display = isDefaultServer ? 'none' : 'block';
  }

  serverSettingsModal.style.display = 'flex';
  setTimeout(() => {
    if (editServerName) editServerName.focus();
  }, 50);
}

async function confirmDeleteServer() {
  const currentServer = servers.find(s => s.id === currentServerId);
  if (!currentServer) return;
  if (currentServer.id === 'default-server') {
    await showAlertModal({ title: 'Notice', message: 'The default server cannot be deleted.', type: 'warning' });
    return;
  }
  if (await showConfirmModal({
    title: 'Delete Server',
    message: `Are you sure you want to delete "${currentServer.name}"? This action cannot be undone and will permanently delete all channels and messages in this server.`,
    confirmText: 'Delete Server',
    danger: true
  })) {
    sendWS('server:delete', { serverId: currentServer.id });
    if (serverSettingsModal) serverSettingsModal.style.display = 'none';
    closeServerDropdown();
  }
}

if (serverMenuSettings) {
  serverMenuSettings.addEventListener('click', () => {
    closeServerDropdown();
    openServerSettingsModal();
  });
}

if (serverMenuDelete) {
  serverMenuDelete.addEventListener('click', () => {
    closeServerDropdown();
    confirmDeleteServer();
  });
}

if (deleteServerBtn) {
  deleteServerBtn.addEventListener('click', confirmDeleteServer);
}

if (saveServerSettingsBtn) {
  saveServerSettingsBtn.addEventListener('click', () => {
    const currentServer = servers.find(s => s.id === currentServerId);
    if (!currentServer) return;
    const name = editServerName ? editServerName.value.trim() : '';
    if (!name) {
      if (editServerError) editServerError.textContent = 'Server name required';
      return;
    }
    sendWS('server:update', {
      serverId: currentServer.id,
      name,
      icon: editServerSelectedIcon
    });
    if (serverSettingsModal) serverSettingsModal.style.display = 'none';
  });
}

document.querySelectorAll('#edit-server-premade-icons .premade-icon-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#edit-server-premade-icons .premade-icon-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editServerSelectedIcon = btn.dataset.icon;
    if (editServerIconPreview) editServerIconPreview.src = editServerSelectedIcon;
  });
});

if (editServerUploadBtn && editServerIconFile) {
  editServerUploadBtn.addEventListener('click', () => editServerIconFile.click());
  editServerIconFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: localStorage.getItem('token') },
        body: formData
      });
      const data = await res.json();
      if (data.url) {
        editServerSelectedIcon = data.url;
        if (editServerIconPreview) editServerIconPreview.src = data.url;
        document.querySelectorAll('#edit-server-premade-icons .premade-icon-btn').forEach(b => b.classList.remove('active'));
      }
    } catch (err) {
      console.error('Server icon upload failed:', err);
    }
  });
}

if (submitCreateServerBtn) {
  submitCreateServerBtn.addEventListener('click', submitCreateServer);
}
if (createServerName) {
  createServerName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitCreateServer();
  });
}

function submitCreateServer() {
  if (!createServerName) return;
  const name = createServerName.value.trim();
  if (!name) {
    if (createServerError) createServerError.textContent = 'Server name required';
    return;
  }
  sendWS('server:create', { name, icon: createServerSelectedIcon });
  if (createServerModal) createServerModal.style.display = 'none';
  createServerName.value = '';
  if (createServerError) createServerError.textContent = '';
}

if (submitCreateCategoryBtn) {
  submitCreateCategoryBtn.addEventListener('click', submitCreateCategory);
}
if (createCategoryName) {
  createCategoryName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitCreateCategory();
  });
}

function submitCreateCategory() {
  if (!createCategoryName) return;
  const name = createCategoryName.value.trim();
  if (!name) {
    if (createCategoryError) createCategoryError.textContent = 'Category name required';
    return;
  }
  sendWS('category:create', { serverId: currentServerId, name });
  if (createCategoryModal) createCategoryModal.style.display = 'none';
  createCategoryName.value = '';
  if (createCategoryError) createCategoryError.textContent = '';
}

function renderServerMembersModal() {
  if (!serverMembersList) return;
  serverMembersList.innerHTML = '';

  const currentServer = servers.find(s => s.id === currentServerId);
  if (!currentServer) return;

  if (serverMembersModalTitle) {
    serverMembersModalTitle.textContent = `${currentServer.name} Members`;
  }

  const isServerOwner = currentUser && (currentServer.ownerId === currentUser.id);
  const canManage = currentUser && (isAdmin(currentUser.role) || isServerOwner);
  const serverMembers = Array.isArray(currentServer.members) ? currentServer.members : [];

  allUsersData.forEach(user => {
    if (user.isDeleted) return;
    const row = document.createElement('div');
    row.className = 'server-member-row';

    const userLeft = document.createElement('div');
    userLeft.className = 'server-member-row-info';

    const avatarUrl = getUserAvatarUrl(user);
    const isMember = serverMembers.includes(user.id);
    const isOwner = currentServer.ownerId === user.id;

    userLeft.innerHTML = `
      <img src="${avatarUrl}" alt="${escapeHtml(user.username)}">
      <div>
        <div style="font-weight:600;font-size:14px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
          <span>${escapeHtml(user.username)}</span>
          ${isOwner ? '<span class="role-badge owner" style="font-size:10px;padding:2px 6px;">OWNER</span>' : (user.role === 'admin' ? '<span class="role-badge admin" style="font-size:10px;padding:2px 6px;">ADMIN</span>' : '')}
        </div>
        <div style="font-size:12px;color:var(--text-muted);">${isOwner ? 'Server Owner' : (isMember ? 'Member' : 'Not in Server')}</div>
      </div>
    `;

    const actionDiv = document.createElement('div');
    if (isOwner) {
      actionDiv.innerHTML = `<span style="font-size:12px;color:var(--accent);font-weight:600;">Owner</span>`;
    } else if (canManage) {
      const btn = document.createElement('button');
      btn.className = isMember ? 'btn-secondary btn-sm' : 'btn-primary btn-sm';
      btn.textContent = isMember ? 'Remove' : 'Add';
      btn.style.fontSize = '12px';
      btn.style.padding = '4px 12px';
      btn.addEventListener('click', () => {
        if (isMember) {
          sendWS('server:member:remove', { serverId: currentServer.id, userId: user.id });
        } else {
          sendWS('server:member:add', { serverId: currentServer.id, userId: user.id });
        }
      });
      actionDiv.appendChild(btn);
    } else {
      actionDiv.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">${isMember ? 'Member' : 'Not Member'}</span>`;
    }

    row.appendChild(userLeft);
    row.appendChild(actionDiv);
    serverMembersList.appendChild(row);
  });
}

if (railSwitcherBtn) {
  railSwitcherBtn.addEventListener('click', () => {
    const quickSwitcherBtn = document.getElementById('quick-switcher-btn');
    if (quickSwitcherBtn) quickSwitcherBtn.click();
  });
}

if (dmFilterInput) {
  dmFilterInput.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    const items = dmList ? dmList.querySelectorAll('.dm-item-wrap') : [];
    items.forEach(wrap => {
      const usernameEl = wrap.querySelector('.dm-username');
      const name = (usernameEl ? usernameEl.textContent : '').toLowerCase();
      wrap.style.display = name.includes(q) ? '' : 'none';
    });
  });
}

if (dmLogoutBtn) {
  dmLogoutBtn.addEventListener('click', () => {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.click();
  });
}

if (dmProfileCallBtn) {
  dmProfileCallBtn.addEventListener('click', () => {
    const dmCallBtn = document.getElementById('dm-call-btn');
    if (dmCallBtn && dmCallBtn.style.display !== 'none') {
      dmCallBtn.click();
    }
  });
}

const userPanelProfile = document.getElementById('user-panel-profile');

/* ── Presence & Status System ────────────────────────────────────────── */

function setUserStatus(newStatus, isAuto = false) {
  if (!currentUser) return;
  if (isAuto) {
    isAutoIdle = true;
  } else {
    isAutoIdle = false;
  }
  currentUser.status = newStatus;
  updateUserStatusDisplay();
  sendWS('user:status:update', { status: newStatus });
}

function setCustomStatus(text) {
  if (!currentUser) return;
  currentUser.customStatus = (text || '').trim();
  updateUserStatusDisplay();
  sendWS('user:status:update', { customStatus: currentUser.customStatus });
}

function updateUserStatusDisplay() {
  if (!currentUser) return;
  const status = currentUser.status || 'online';
  if (userStatusDot) {
    userStatusDot.className = `user-status-dot ${status}`;
  }
  if (userCustomStatusEl) {
    if (currentUser.customStatus) {
      userCustomStatusEl.textContent = currentUser.customStatus;
      userCustomStatusEl.title = currentUser.customStatus;
      userCustomStatusEl.style.display = 'block';
    } else {
      userCustomStatusEl.style.display = 'none';
    }
  }
  if (statusPickerMenu) {
    statusPickerMenu.querySelectorAll('.status-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.status === status);
    });
  }
}

function openStatusPicker() {
  if (!statusPickerMenu) return;
  statusPickerMenu.style.display = 'flex';
  if (customStatusInput) {
    customStatusInput.value = (currentUser && currentUser.customStatus) || '';
  }
  updateUserStatusDisplay();
}

function closeStatusPicker() {
  if (!statusPickerMenu) return;
  statusPickerMenu.style.display = 'none';
}

function handleUserPresenceActivity() {
  lastUserActivityTime = Date.now();
  if (isAutoIdle && currentUser && currentUser.status === 'idle') {
    isAutoIdle = false;
    setUserStatus('online', false);
  }
}

['mousemove', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
  window.addEventListener(evt, handleUserPresenceActivity, { passive: true });
});

// Auto-idle check: after 5 minutes of inactivity, set to idle
const autoIdleTimeoutMs = 5 * 60 * 1000;
function checkAutoIdle() {
  if (!currentUser || !wsAuthenticated) return;
  const timeSinceActivity = Date.now() - lastUserActivityTime;
  if (timeSinceActivity >= autoIdleTimeoutMs && (!currentUser.status || currentUser.status === 'online')) {
    setUserStatus('idle', true);
  }
}
const autoIdleInterval = setInterval(checkAutoIdle, 30000);
if (autoIdleInterval && typeof autoIdleInterval.unref === 'function') {
  autoIdleInterval.unref();
}

if (userPanelProfile) {
  userPanelProfile.addEventListener('click', (e) => {
    e.stopPropagation();
    if (statusPickerMenu && statusPickerMenu.style.display === 'flex') {
      closeStatusPicker();
    } else {
      openStatusPicker();
    }
  });
}

if (statusPickerMenu) {
  statusPickerMenu.querySelectorAll('.status-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      const status = opt.dataset.status;
      if (status) {
        setUserStatus(status, false);
        closeStatusPicker();
      }
    });
  });
  statusPickerMenu.addEventListener('click', (e) => e.stopPropagation());
}

if (statusPickerCloseBtn) {
  statusPickerCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeStatusPicker();
  });
}

if (customStatusSaveBtn && customStatusInput) {
  customStatusSaveBtn.addEventListener('click', () => {
    setCustomStatus(customStatusInput.value);
    closeStatusPicker();
  });
  customStatusInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      setCustomStatus(customStatusInput.value);
      closeStatusPicker();
    }
  });
}

if (customStatusClearBtn) {
  customStatusClearBtn.addEventListener('click', () => {
    if (customStatusInput) customStatusInput.value = '';
    setCustomStatus('');
    closeStatusPicker();
  });
}

document.addEventListener('click', (e) => {
  if (statusPickerMenu && statusPickerMenu.style.display === 'flex') {
    if (!statusPickerMenu.contains(e.target) && userPanelProfile && !userPanelProfile.contains(e.target)) {
      closeStatusPicker();
    }
  }
});

/* ── Profile Popover System ─────────────────────────────────────────── */
let activeProfilePopoverUserId = null;

function showUserProfilePopover(userId, targetEl) {
  const popover = document.getElementById('user-profile-popover');
  if (!popover) return;

  const user = (allUsersData && allUsersData.find(u => u.id === userId)) ||
    (currentUser && currentUser.id === userId ? currentUser : null) ||
    { id: userId, username: 'Unknown', role: 'user', profilePic: getDefaultAvatar(userId) };

  activeProfilePopoverUserId = userId;

  const avatarImg = document.getElementById('popover-avatar');
  const statusDot = document.getElementById('popover-status-dot');
  const usernameEl = document.getElementById('popover-username');
  const roleBadge = document.getElementById('popover-role-badge');
  const customStatusEl = document.getElementById('popover-custom-status');
  const bioEl = document.getElementById('popover-bio');
  const actionBtn = document.getElementById('popover-action-btn');
  const callBtn = document.getElementById('popover-call-btn');

  if (avatarImg) avatarImg.src = getUserAvatarUrl(user);
  if (usernameEl) usernameEl.textContent = user.username || 'Unknown';

  if (statusDot) {
    const isOnline = (typeof onlineUsersData !== 'undefined' && Array.isArray(onlineUsersData) && onlineUsersData.some(u => u.id === user.id)) || (currentUser && currentUser.id === user.id);
    const status = isOnline ? (user.status || 'online') : 'offline';
    statusDot.className = `user-status-dot ${status}`;
  }

  if (roleBadge) {
    const role = (user.role || 'user').toLowerCase();
    roleBadge.textContent = role.toUpperCase();
    roleBadge.className = `role-badge ${role}`;
    roleBadge.style.display = (role === 'admin' || role === 'owner') ? 'inline-flex' : 'none';
  }

  if (customStatusEl) {
    if (user.customStatus) {
      customStatusEl.textContent = `“${user.customStatus}”`;
      customStatusEl.style.display = 'block';
    } else {
      customStatusEl.style.display = 'none';
    }
  }

  if (bioEl) {
    bioEl.textContent = user.aboutMe || '';
  }

  const isSelf = currentUser && user.id === currentUser.id;
  if (actionBtn) {
    if (isSelf) {
      actionBtn.innerHTML = '<i class="ph-bold ph-pencil-simple"></i><span>Edit Profile</span>';
      actionBtn.onclick = (e) => {
        e.stopPropagation();
        hideUserProfilePopover();
        openSettingsModal();
      };
      if (callBtn) callBtn.style.display = 'none';
    } else {
      actionBtn.innerHTML = '<i class="ph-bold ph-chat-circle-dots"></i><span>Message</span>';
      actionBtn.onclick = (e) => {
        e.stopPropagation();
        hideUserProfilePopover();
        startDM(user.id);
      };
      if (callBtn) {
        callBtn.style.display = 'flex';
        callBtn.onclick = (e) => {
          e.stopPropagation();
          hideUserProfilePopover();
          if (typeof initiateDirectCall === 'function') {
            initiateDirectCall(user.id);
          } else {
            startDM(user.id);
          }
        };
      }
    }
  }

  popover.style.display = 'block';
  popover.style.visibility = 'hidden';

  requestAnimationFrame(() => {
    const rect = targetEl ? targetEl.getBoundingClientRect() : { top: 100, left: 100, bottom: 100, right: 100 };
    const popoverRect = popover.getBoundingClientRect();

    let left = rect.right + 12;
    let top = rect.top;

    if (left + popoverRect.width > window.innerWidth - 16) {
      left = rect.left - popoverRect.width - 12;
    }
    if (left < 16) {
      left = Math.max(16, (window.innerWidth - popoverRect.width) / 2);
    }
    if (top + popoverRect.height > window.innerHeight - 16) {
      top = Math.max(16, window.innerHeight - popoverRect.height - 16);
    }

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    popover.style.visibility = 'visible';
  });
}

function hideUserProfilePopover() {
  const popover = document.getElementById('user-profile-popover');
  if (popover) {
    popover.style.display = 'none';
  }
  activeProfilePopoverUserId = null;
}

document.addEventListener('click', (e) => {
  const popover = document.getElementById('user-profile-popover');
  if (popover && popover.style.display !== 'none') {
    if (!popover.contains(e.target) && !e.target.closest('.message-avatar') && !e.target.closest('.message-username') && !e.target.closest('.user-list-item')) {
      hideUserProfilePopover();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideUserProfilePopover();
    if (voiceSettingsModal && voiceSettingsModal.style.display !== 'none') {
      voiceSettingsModal.style.display = 'none';
      stopMicTest();
    }
    if (settingsModal && settingsModal.style.display !== 'none') {
      stopMicTest();
    }
  }
});

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => {
    stopMicTest();
    if (voiceSettingsModal) voiceSettingsModal.style.display = 'none';
    settingsModal.style.display = 'none';
    channelModal.style.display = 'none';
    adminModal.style.display = 'none';
    if (createServerModal) createServerModal.style.display = 'none';
    if (createCategoryModal) createCategoryModal.style.display = 'none';
    if (serverMembersModal) serverMembersModal.style.display = 'none';
    if (serverSettingsModal) serverSettingsModal.style.display = 'none';
    if (channelSettingsModal) channelSettingsModal.style.display = 'none';
  });
});

[settingsModal, voiceSettingsModal, channelModal, adminModal, createServerModal, createCategoryModal, serverMembersModal, serverSettingsModal, channelSettingsModal].forEach(modal => {
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
        if (modal === voiceSettingsModal || modal === settingsModal) {
          stopMicTest();
        }
      }
    });
  }
});

uploadPicBtn.addEventListener('click', () => profilePicInput.click());

if (adjustPicBtn) {
  adjustPicBtn.addEventListener('click', () => {
    const currentAvatar = getUserAvatarUrl(currentUser);
    if (currentAvatar) {
      openAvatarCropper(currentAvatar);
    }
  });
}

profilePicInput.addEventListener('change', () => {
  if (profilePicInput.files.length === 0) return;
  const file = profilePicInput.files[0];
  if (!file.type.startsWith('image/')) {
    const errEl = document.getElementById('settings-error');
    if (errEl) {
      errEl.textContent = 'Please select a valid image file';
      errEl.style.color = 'var(--danger)';
    }
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    openAvatarCropper(e.target.result);
  };
  reader.readAsDataURL(file);
});

/* Avatar Cropper & Position Adjuster */
let cropImageSrc = null;
let cropZoom = 1;
let cropPanX = 0;
let cropPanY = 0;
let cropBaseW = 200;
let cropBaseH = 200;
let isDraggingCrop = false;
let dragStartX = 0;
let dragStartY = 0;
let panStartX = 0;
let panStartY = 0;

function updateCropTransform() {
  const currentW = cropBaseW * cropZoom;
  const currentH = cropBaseH * cropZoom;

  const maxPanX = Math.max(0, (currentW - 200) / 2);
  const maxPanY = Math.max(0, (currentH - 200) / 2);
  cropPanX = Math.min(maxPanX, Math.max(-maxPanX, cropPanX));
  cropPanY = Math.min(maxPanY, Math.max(-maxPanY, cropPanY));

  avatarCropImg.style.transform = `translate(${cropPanX}px, ${cropPanY}px) scale(${cropZoom})`;
}

function openAvatarCropper(imageSrc) {
  if (!imageSrc || !avatarCropModal) return;
  cropImageSrc = imageSrc;
  avatarCropImg.crossOrigin = 'anonymous';
  avatarCropImg.src = imageSrc;
  avatarCropModal.style.display = 'flex';
  cropZoom = 1;
  if (avatarCropZoom) avatarCropZoom.value = '1';
  cropPanX = 0;
  cropPanY = 0;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const nw = img.naturalWidth || 200;
    const nh = img.naturalHeight || 200;
    const scale = 200 / Math.min(nw, nh);
    cropBaseW = nw * scale;
    cropBaseH = nh * scale;

    avatarCropImg.style.width = `${cropBaseW}px`;
    avatarCropImg.style.height = `${cropBaseH}px`;
    avatarCropImg.style.left = `${(240 - cropBaseW) / 2}px`;
    avatarCropImg.style.top = `${(240 - cropBaseH) / 2}px`;
    updateCropTransform();
  };
  img.src = imageSrc;
}

function closeAvatarCropper() {
  if (avatarCropModal) avatarCropModal.style.display = 'none';
  if (avatarCropImg) avatarCropImg.src = '';
  cropImageSrc = null;
}

if (avatarCropViewport) {
  avatarCropViewport.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDraggingCrop = true;
    avatarCropViewport.classList.add('dragging');
    try { avatarCropViewport.setPointerCapture(e.pointerId); } catch (_) {}
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = cropPanX;
    panStartY = cropPanY;
  });

  avatarCropViewport.addEventListener('pointermove', (e) => {
    if (!isDraggingCrop) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    cropPanX = panStartX + dx;
    cropPanY = panStartY + dy;
    updateCropTransform();
  });

  const endDrag = (e) => {
    if (isDraggingCrop) {
      isDraggingCrop = false;
      avatarCropViewport.classList.remove('dragging');
      try { avatarCropViewport.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };

  avatarCropViewport.addEventListener('pointerup', endDrag);
  avatarCropViewport.addEventListener('pointercancel', endDrag);

  avatarCropViewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.08 : -0.08;
    cropZoom = Math.min(3, Math.max(1, Math.round((cropZoom + delta) * 100) / 100));
    if (avatarCropZoom) avatarCropZoom.value = String(cropZoom);
    updateCropTransform();
  }, { passive: false });
}

if (avatarCropZoom) {
  avatarCropZoom.addEventListener('input', (e) => {
    cropZoom = parseFloat(e.target.value) || 1;
    updateCropTransform();
  });
}

if (cropZoomInBtn) {
  cropZoomInBtn.addEventListener('click', () => {
    cropZoom = Math.min(3, Math.round((cropZoom + 0.1) * 100) / 100);
    if (avatarCropZoom) avatarCropZoom.value = String(cropZoom);
    updateCropTransform();
  });
}

if (cropZoomOutBtn) {
  cropZoomOutBtn.addEventListener('click', () => {
    cropZoom = Math.max(1, Math.round((cropZoom - 0.1) * 100) / 100);
    if (avatarCropZoom) avatarCropZoom.value = String(cropZoom);
    updateCropTransform();
  });
}

if (avatarCropResetBtn) {
  avatarCropResetBtn.addEventListener('click', () => {
    cropZoom = 1;
    if (avatarCropZoom) avatarCropZoom.value = '1';
    cropPanX = 0;
    cropPanY = 0;
    updateCropTransform();
  });
}

if (avatarCropCancelBtn) {
  avatarCropCancelBtn.addEventListener('click', closeAvatarCropper);
}
if (avatarCropCloseBtn) {
  avatarCropCloseBtn.addEventListener('click', closeAvatarCropper);
}
if (avatarCropModal) {
  avatarCropModal.addEventListener('click', (e) => {
    if (e.target === avatarCropModal) closeAvatarCropper();
  });
}

if (avatarCropSaveBtn) {
  avatarCropSaveBtn.addEventListener('click', async () => {
    if (!token) {
      const errEl = document.getElementById('settings-error');
      if (errEl) {
        errEl.textContent = 'Not logged in';
        errEl.style.color = 'var(--danger)';
      }
      return;
    }
    if (!cropImageSrc) return;

    avatarCropSaveBtn.disabled = true;
    avatarCropSaveBtn.textContent = 'Saving...';

    try {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');

      const img = new Image();
      img.crossOrigin = 'anonymous';

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = cropImageSrc;
      });

      const canvasScale = 256 / 200;
      const currentW = cropBaseW * cropZoom;
      const currentH = cropBaseH * cropZoom;
      const canvasW = currentW * canvasScale;
      const canvasH = currentH * canvasScale;
      const canvasCX = 128 + cropPanX * canvasScale;
      const canvasCY = 128 + cropPanY * canvasScale;
      const canvasX = canvasCX - canvasW / 2;
      const canvasY = canvasCY - canvasH / 2;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, canvasX, canvasY, canvasW, canvasH);

      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/png');
      });

      if (!blob) throw new Error('Failed to generate image');

      const formData = new FormData();
      formData.append('file', blob, 'avatar.png');

      const res = await fetch('/api/upload/profile', {
        method: 'POST',
        headers: { Authorization: token },
        body: formData
      });

      if (res.ok) {
        const data = await res.json();
        currentUser.profilePic = data.url;
        settingsProfilePic.style.display = 'block';
        settingsProfilePic.src = data.url;
        renderUserInfo();

        const myIdx = allUsersData.findIndex(u => u.id === currentUser.id);
        if (myIdx !== -1) {
          allUsersData[myIdx].profilePic = data.url;
        }

        document.querySelectorAll(`#messages-container .message[data-user-id="${currentUser.id}"]`).forEach(msg => {
          const avatarDiv = msg.querySelector('.message-avatar');
          if (avatarDiv) {
            avatarDiv.innerHTML = `<img src="${data.url}" alt="${escapeHtml(currentUser.username)}">`;
          }
        });

        const onlineMe = onlineUsersData.find(u => u.id === currentUser.id);
        if (onlineMe) {
          onlineMe.profilePic = data.url;
          renderOnlineUsers(onlineUsersData);
        }

        closeAvatarCropper();
        const errEl = document.getElementById('settings-error');
        if (errEl) {
          errEl.textContent = 'Avatar updated successfully!';
          errEl.style.color = 'var(--success)';
          setTimeout(() => {
            if (errEl.textContent === 'Avatar updated successfully!') errEl.textContent = '';
          }, 3000);
        }
      } else if (res.status === 401) {
        const errEl = document.getElementById('settings-error');
        if (errEl) {
          errEl.textContent = 'Session expired. Please login again.';
          errEl.style.color = 'var(--danger)';
        }
      } else {
        const err = await res.json();
        const errEl = document.getElementById('settings-error');
        if (errEl) {
          errEl.textContent = err.error || 'Upload failed';
          errEl.style.color = 'var(--danger)';
        }
      }
    } catch (err) {
      console.error('Profile crop upload failed:', err);
      const errEl = document.getElementById('settings-error');
      if (errEl) {
        errEl.textContent = 'Failed to process avatar';
        errEl.style.color = 'var(--danger)';
      }
    } finally {
      avatarCropSaveBtn.disabled = false;
      avatarCropSaveBtn.textContent = 'Save Picture';
      if (profilePicInput) profilePicInput.value = '';
    }
  });
}

/* Save Settings (Name / Password) */

document.getElementById('save-settings-btn').addEventListener('click', () => {
  const newUsername = document.getElementById('settings-username').value.trim();
  const currentPassword = document.getElementById('settings-current-password').value;
  const newPassword = document.getElementById('settings-password').value.trim();
  const aboutMeInput = document.getElementById('settings-aboutme');
  const newAboutMe = aboutMeInput ? aboutMeInput.value.trim() : undefined;
  const errEl = document.getElementById('settings-error');
  errEl.style.color = 'var(--danger)';

  const aboutMeChanged = newAboutMe !== undefined && newAboutMe !== (currentUser ? (currentUser.aboutMe || '') : '');

  if (!newUsername && !newPassword && !aboutMeChanged) {
    errEl.textContent = 'No changes to save';
    return;
  }
  if (newUsername && (newUsername.length < 2 || newUsername.length > 20)) {
    errEl.textContent = 'Username must be 2-20 characters';
    return;
  }
  if (newPassword) {
    if (!currentPassword) {
      errEl.textContent = 'Enter your current password to change it';
      return;
    }
    if (newPassword.length < 8) {
      errEl.textContent = 'Password must be at least 8 characters';
      return;
    }
  }

  errEl.textContent = '';
  sendWS('user:update', {
    username: newUsername || undefined,
    password: newPassword || undefined,
    currentPassword: newPassword ? currentPassword : undefined,
    aboutMe: newAboutMe !== undefined ? newAboutMe : undefined
  });
});

/* Create Channel (Admin) */

function resetCreateChannelModal() {
  if (channelNameInput) channelNameInput.value = '';
  if (channelError) channelError.textContent = '';
  const textRadio = document.querySelector('input[name="channel-type"][value="text"]');
  if (textRadio) textRadio.checked = true;
  if (createChannelPrivateToggle) createChannelPrivateToggle.checked = false;
  if (createChannelMembersWrap) createChannelMembersWrap.style.display = 'none';
  if (createChannelMembersList) createChannelMembersList.innerHTML = '';
  if (createChannelMembersContainer) createChannelMembersContainer.innerHTML = '';
}

if (addChannelBtn) {
  addChannelBtn.addEventListener('click', () => {
    resetCreateChannelModal();
    channelModal.style.display = 'flex';
    setTimeout(() => channelNameInput.focus(), 100);
  });
}

if (createChannelPrivateToggle) {
  createChannelPrivateToggle.addEventListener('change', () => {
    if (createChannelPrivateToggle.checked) {
      if (createChannelMembersWrap) createChannelMembersWrap.style.display = 'block';
      const curServer = servers.find(s => s.id === currentServerId);
      if (createChannelMembersList) {
        renderChannelMembersChecklist(createChannelMembersList, curServer, []);
      }
      if (createChannelMembersContainer) {
        renderChannelMembersChecklist(createChannelMembersContainer, curServer, []);
      }
    } else {
      if (createChannelMembersWrap) createChannelMembersWrap.style.display = 'none';
    }
  });
}

channelModal.addEventListener('click', (e) => {
  if (e.target === channelModal) channelModal.style.display = 'none';
});

channelNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createChannel();
});

createChannelBtn.addEventListener('click', createChannel);

function createChannel() {
  const name = channelNameInput.value.trim();
  if (!name) {
    channelError.textContent = 'Channel name required';
    return;
  }
  if (name.length < 2) {
    channelError.textContent = 'Name must be at least 2 characters';
    return;
  }
  const channelType = document.querySelector('input[name="channel-type"]:checked').value;
  const isPrivate = !!(createChannelPrivateToggle && createChannelPrivateToggle.checked);
  let allowedMembers = [];
  if (isPrivate && createChannelMembersWrap) {
    const listEl = createChannelMembersList || createChannelMembersContainer || createChannelMembersWrap;
    const checkedBoxes = listEl.querySelectorAll('input[type="checkbox"]:checked');
    allowedMembers = Array.from(checkedBoxes).map(cb => cb.value);
  }
  channelError.textContent = '';
  sendWS('channel:create', {
    name,
    channelType,
    serverId: currentServerId,
    categoryId: targetCategoryIdForNewChannel || (channelType === 'voice' ? 'cat-voice' : 'cat-text'),
    isPrivate,
    allowedMembers
  });
  targetCategoryIdForNewChannel = null;
  channelModal.style.display = 'none';
}

/* ── Channel Settings Modal ────────────────────────────────────────── */

function renderChannelMembersChecklist(containerEl, server, allowedMemberIds = []) {
  if (!containerEl) return;
  containerEl.innerHTML = '';
  if (!server) return;

  const serverMembers = Array.isArray(server.members) ? server.members : [];
  const allowedSet = new Set(Array.isArray(allowedMemberIds) ? allowedMemberIds : []);

  allUsersData.forEach(user => {
    if (user.isDeleted) return;
    if (!serverMembers.includes(user.id)) return;

    const isOwner = server.ownerId === user.id;
    const isAdminUser = user.role === 'admin' || user.role === 'owner';
    const isPrivileged = isOwner || isAdminUser;

    const item = document.createElement('label');
    item.className = 'channel-member-check-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'channel-member-checkbox';
    checkbox.value = user.id;
    if (isPrivileged) {
      checkbox.checked = true;
      checkbox.disabled = true;
    } else {
      checkbox.checked = allowedSet.has(user.id);
    }

    const avatar = document.createElement('img');
    avatar.className = 'channel-member-avatar';
    avatar.src = getUserAvatarUrl(user);
    avatar.alt = user.username;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'channel-member-name';
    nameSpan.textContent = user.username;

    item.appendChild(checkbox);
    item.appendChild(avatar);
    item.appendChild(nameSpan);

    if (isPrivileged) {
      const badge = document.createElement('span');
      badge.className = 'channel-member-badge privileged';
      badge.textContent = isOwner ? 'Owner' : (user.role === 'owner' ? 'Owner' : 'Admin');
      item.appendChild(badge);
    }

    containerEl.appendChild(item);
  });
}

let editingChannelSettingsId = null;

function openChannelSettingsModal(channel) {
  if (!channel || !channelSettingsModal) return;
  editingChannelSettingsId = channel.id;

  if (channelSettingsTitle) {
    channelSettingsTitle.textContent = `${channel.name} Settings`;
  }
  if (channelSettingsNameInput) {
    channelSettingsNameInput.value = channel.name || '';
  }
  if (channelSettingsError) {
    channelSettingsError.textContent = '';
  }

  const isPrivate = !!channel.isPrivate;
  if (channelSettingsPrivateToggle) {
    channelSettingsPrivateToggle.checked = isPrivate;
  }

  const curServer = servers.find(s => s.id === (channel.serverId || currentServerId)) || servers.find(s => s.id === currentServerId);
  const allowed = Array.isArray(channel.allowedMembers) ? channel.allowedMembers : [];

  if (channelSettingsMembersSection) {
    channelSettingsMembersSection.style.display = isPrivate ? 'block' : 'none';
  }

  if (channelSettingsMembersList) {
    renderChannelMembersChecklist(channelSettingsMembersList, curServer, allowed);
  }

  channelSettingsModal.style.display = 'flex';
  setTimeout(() => {
    if (channelSettingsNameInput) channelSettingsNameInput.focus();
  }, 100);
}

if (channelSettingsPrivateToggle) {
  channelSettingsPrivateToggle.addEventListener('change', () => {
    const isPrivate = channelSettingsPrivateToggle.checked;
    if (channelSettingsMembersSection) {
      channelSettingsMembersSection.style.display = isPrivate ? 'block' : 'none';
    }
  });
}

if (channelSettingsCancelBtn) {
  channelSettingsCancelBtn.addEventListener('click', () => {
    if (channelSettingsModal) channelSettingsModal.style.display = 'none';
  });
}

if (channelSettingsCloseBtn) {
  channelSettingsCloseBtn.addEventListener('click', () => {
    if (channelSettingsModal) channelSettingsModal.style.display = 'none';
  });
}

if (channelSettingsNameInput) {
  channelSettingsNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (channelSettingsSaveBtn) channelSettingsSaveBtn.click();
    }
  });
}

if (channelSettingsSaveBtn) {
  channelSettingsSaveBtn.addEventListener('click', () => {
    if (!editingChannelSettingsId) return;
    const name = channelSettingsNameInput ? channelSettingsNameInput.value.trim() : '';
    if (!name) {
      if (channelSettingsError) channelSettingsError.textContent = 'Channel name required';
      return;
    }
    if (name.length < 2) {
      if (channelSettingsError) channelSettingsError.textContent = 'Name must be at least 2 characters';
      return;
    }
    const isPrivate = !!(channelSettingsPrivateToggle && channelSettingsPrivateToggle.checked);
    let allowedMembers = [];
    if (isPrivate && channelSettingsMembersList) {
      const checkedBoxes = channelSettingsMembersList.querySelectorAll('input[type="checkbox"]:checked');
      allowedMembers = Array.from(checkedBoxes).map(cb => cb.value);
    }

    sendWS('channel:permissions:update', {
      channelId: editingChannelSettingsId,
      name,
      isPrivate,
      allowedMembers
    });

    if (channelSettingsModal) channelSettingsModal.style.display = 'none';
  });
}

/* ── Quick Switcher (Ctrl+K) ────────────────────────────────────────── */

function openQuickSwitcher() {
  if (!currentUser) return;
  quickSwitcherSelectedIndex = 0;
  if (quickSwitcherModal) quickSwitcherModal.style.display = 'flex';
  if (quickSwitcherInput) {
    quickSwitcherInput.value = '';
    renderQuickSwitcherResults('');
    setTimeout(() => quickSwitcherInput.focus(), 30);
  }
}

function closeQuickSwitcher() {
  if (!quickSwitcherModal) return;
  quickSwitcherModal.style.display = 'none';
  if (messageInput) messageInput.focus();
}

function getQuickSwitcherAllItems() {
  const items = [];

  // Group server channels by Server Name
  if (Array.isArray(servers) && servers.length > 0) {
    servers.forEach(server => {
      const serverChs = (channels || []).filter(c => c.type !== 'dm' && (c.serverId || 'default-server') === server.id)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      serverChs.forEach(ch => {
        items.push({
          id: ch.id,
          type: ch.type || 'text',
          name: ch.name,
          serverId: server.id,
          serverName: server.name,
          category: server.name.toUpperCase(),
          unread: (unreadCounts[ch.id] || 0) + (mentionCounts[ch.id] || 0),
          isChannel: true
        });
      });
    });
  } else {
    const regularChannels = (channels || []).filter(c => c.type !== 'dm').sort((a, b) => (a.order || 0) - (b.order || 0));
    regularChannels.forEach(ch => {
      items.push({
        id: ch.id,
        type: ch.type || 'text',
        name: ch.name,
        serverId: ch.serverId || 'default-server',
        serverName: 'Channels',
        category: 'CHANNELS',
        unread: (unreadCounts[ch.id] || 0) + (mentionCounts[ch.id] || 0),
        isChannel: true
      });
    });
  }

  // Existing DMs
  const dmChannels = (channels || []).filter(c => c.type === 'dm');
  const existingDmUserIds = new Set();
  dmChannels.forEach(ch => {
    const otherUser = ch.dmUser || {};
    const latestUser = allUsersData.find(u => u.id === otherUser.id) || otherUser;
    if (latestUser && latestUser.id) existingDmUserIds.add(latestUser.id);
    items.push({
      id: ch.id,
      type: 'dm',
      name: latestUser.username || 'Direct Message',
      category: 'Direct Messages',
      avatarUrl: getUserAvatarUrl(latestUser),
      unread: (unreadCounts[ch.id] || 0) + (mentionCounts[ch.id] || 0),
      isDm: true
    });
  });

  // Other registered users
  allUsersData.forEach(u => {
    if (u.id !== currentUser.id && !existingDmUserIds.has(u.id) && !u.isDeleted) {
      items.push({
        id: u.id,
        type: 'user',
        name: u.username,
        category: 'Users',
        avatarUrl: getUserAvatarUrl(u),
        isNewDmUser: true
      });
    }
  });

  return items;
}

function renderQuickSwitcherResults(query) {
  if (!quickSwitcherResults) return;
  const trimmed = (query || '').trim().toLowerCase();
  const all = getQuickSwitcherAllItems();

  if (!trimmed) {
    quickSwitcherFilteredItems = all;
  } else {
    quickSwitcherFilteredItems = all.filter(item => {
      return item.name.toLowerCase().includes(trimmed);
    });
  }

  quickSwitcherResults.innerHTML = '';

  if (quickSwitcherFilteredItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'quick-switcher-empty';
    empty.textContent = `No channels or users matching "${trimmed}"`;
    quickSwitcherResults.appendChild(empty);
    quickSwitcherSelectedIndex = 0;
    return;
  }

  if (quickSwitcherSelectedIndex >= quickSwitcherFilteredItems.length) {
    quickSwitcherSelectedIndex = 0;
  }

  let currentCategory = null;

  quickSwitcherFilteredItems.forEach((item, index) => {
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      const catHeader = document.createElement('div');
      catHeader.className = 'quick-switcher-section-title';
      catHeader.textContent = currentCategory;
      quickSwitcherResults.appendChild(catHeader);
    }

    const el = document.createElement('div');
    el.className = 'quick-switcher-result-item' + (index === quickSwitcherSelectedIndex ? ' selected' : '');
    el.dataset.index = index;

    let iconHtml = '';
    if (item.avatarUrl) {
      iconHtml = `<img src="${item.avatarUrl}" alt="${escapeHtml(item.name)}">`;
    } else if (item.type === 'voice') {
      iconHtml = '<i class="ph-bold ph-speaker-high"></i>';
    } else {
      iconHtml = '<i class="ph-bold ph-hash"></i>';
    }

    let categoryHint = item.type === 'voice'
      ? (item.serverName ? `${item.serverName} • Voice` : 'Voice Channel')
      : item.type === 'dm'
        ? 'Direct Message'
        : item.type === 'user'
          ? 'Start DM'
          : (item.serverName ? `${item.serverName} • Text` : 'Text Channel');

    el.innerHTML = `
      <div class="quick-switcher-item-icon">${iconHtml}</div>
      <div class="quick-switcher-item-info">
        <span class="quick-switcher-item-name">${escapeHtml(item.name)}</span>
        <span class="quick-switcher-item-category">${categoryHint}</span>
      </div>
      <div class="quick-switcher-enter-hint">
        <span>Jump</span>
        <kbd>↵</kbd>
      </div>
    `;

    el.addEventListener('click', () => {
      selectQuickSwitcherItem(item);
    });

    quickSwitcherResults.appendChild(el);
  });

  const selectedEl = quickSwitcherResults.querySelector('.quick-switcher-result-item.selected');
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

function updateQuickSwitcherSelection() {
  if (!quickSwitcherResults) return;
  const items = quickSwitcherResults.querySelectorAll('.quick-switcher-result-item');
  items.forEach(el => {
    const idx = parseInt(el.dataset.index, 10);
    if (idx === quickSwitcherSelectedIndex) {
      el.classList.add('selected');
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.classList.remove('selected');
    }
  });
}

function selectQuickSwitcherItem(item) {
  if (!item) return;
  closeQuickSwitcher();
  if (item.isNewDmUser) {
    startDM(item.id);
  } else if (item.isChannel && item.serverId && item.serverId !== currentServerId) {
    switchServer(item.serverId, item.id);
  } else if (item.type === 'dm') {
    setSidebarMode('dms');
    switchChannel(item.id);
  } else {
    switchChannel(item.id);
  }
}

if (quickSwitcherBtn) {
  quickSwitcherBtn.addEventListener('click', openQuickSwitcher);
}

if (quickSwitcherModal) {
  quickSwitcherModal.addEventListener('click', (e) => {
    if (e.target === quickSwitcherModal) closeQuickSwitcher();
  });
  const escKbd = quickSwitcherModal.querySelector('.quick-switcher-kbd');
  if (escKbd) escKbd.addEventListener('click', closeQuickSwitcher);
}

if (quickSwitcherInput) {
  quickSwitcherInput.addEventListener('input', (e) => {
    quickSwitcherSelectedIndex = 0;
    renderQuickSwitcherResults(e.target.value);
  });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (quickSwitcherModal && quickSwitcherModal.style.display === 'flex') {
      closeQuickSwitcher();
    } else {
      openQuickSwitcher();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    if (searchModal && searchModal.style.display === 'flex') {
      closeSearchModal();
    } else {
      openSearchModal();
    }
    return;
  }

  if (e.key === 'Escape') {
    if (searchModal && searchModal.style.display === 'flex') {
      e.preventDefault();
      closeSearchModal();
      return;
    }
    if (pinnedDrawer && pinnedDrawer.style.display === 'flex') {
      e.preventDefault();
      closePinnedDrawer();
      return;
    }
  }

  if (quickSwitcherModal && quickSwitcherModal.style.display === 'flex') {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQuickSwitcher();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (quickSwitcherFilteredItems.length > 0) {
        quickSwitcherSelectedIndex = (quickSwitcherSelectedIndex + 1) % quickSwitcherFilteredItems.length;
        updateQuickSwitcherSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (quickSwitcherFilteredItems.length > 0) {
        quickSwitcherSelectedIndex = (quickSwitcherSelectedIndex - 1 + quickSwitcherFilteredItems.length) % quickSwitcherFilteredItems.length;
        updateQuickSwitcherSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (quickSwitcherFilteredItems[quickSwitcherSelectedIndex]) {
        selectQuickSwitcherItem(quickSwitcherFilteredItems[quickSwitcherSelectedIndex]);
      }
    }
  }
});

/* Voice Call */

voiceJoinBtn.addEventListener('click', () => joinVoiceChannel(false));
const voiceListenOnlyBtn = document.getElementById('voice-listen-only-btn');
if (voiceListenOnlyBtn) {
  voiceListenOnlyBtn.addEventListener('click', () => joinVoiceChannel(true));
}
voiceMuteBtn.addEventListener('click', toggleMute);
const sidebarMuteBtn = document.getElementById('sidebar-mute-btn');
if (sidebarMuteBtn) {
  sidebarMuteBtn.addEventListener('click', toggleMute);
}

const voiceDeafenBtn = document.getElementById('voice-deafen-btn');
if (voiceDeafenBtn) {
  voiceDeafenBtn.addEventListener('click', toggleDeafen);
}
const miniplayerDeafenBtn = document.getElementById('miniplayer-deafen-btn');
if (miniplayerDeafenBtn) {
  miniplayerDeafenBtn.addEventListener('click', toggleDeafen);
}
const sidebarDeafenBtn = document.getElementById('sidebar-deafen-btn');
if (sidebarDeafenBtn) {
  sidebarDeafenBtn.addEventListener('click', toggleDeafen);
}

const voiceStatusDisconnectBtn = document.getElementById('voice-status-disconnect-btn');
if (voiceStatusDisconnectBtn) {
  voiceStatusDisconnectBtn.addEventListener('click', () => leaveVoiceChannel(false));
}

voiceScreenBtn.addEventListener('click', toggleScreenShare);
voiceScreenStopBtn.addEventListener('click', toggleScreenShare);
voiceLeaveBtn.addEventListener('click', () => leaveVoiceChannel(false));
const voiceCameraBtn = document.getElementById('voice-camera-btn');
voiceCameraBtn.addEventListener('click', toggleCamera);

function createSilentAudioStream() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const dst = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain);
  gain.connect(dst);
  osc.start();
  const track = dst.stream.getAudioTracks()[0];
  track.enabled = false;
  return dst.stream;
}

function setParticipantVolume(userId, vol) {
  userVolumes[userId] = vol;
  try {
    localStorage.setItem('user_volumes', JSON.stringify(userVolumes));
  } catch (e) {}
  if (voiceAudioElements[userId]) {
    voiceAudioElements[userId].volume = voiceDeafened ? 0 : vol;
  }
}

function toggleDeafen() {
  voiceDeafened = !voiceDeafened;
  const deafenBtns = [
    document.getElementById('voice-deafen-btn'),
    document.getElementById('miniplayer-deafen-btn'),
    document.getElementById('sidebar-deafen-btn')
  ];
  deafenBtns.forEach(btn => {
    if (btn) {
      btn.classList.toggle('deafened', voiceDeafened);
      btn.classList.toggle('muted', voiceDeafened);
      btn.innerHTML = voiceDeafened ? '<i class="ph-bold ph-headphones-slash"></i>' : '<i class="ph-bold ph-headphones"></i>';
      btn.title = voiceDeafened ? 'Undeafen' : 'Deafen';
    }
  });

  Object.keys(voiceAudioElements).forEach(uid => {
    const audio = voiceAudioElements[uid];
    if (audio) {
      const vol = userVolumes[uid] !== undefined ? userVolumes[uid] : 1.0;
      audio.volume = voiceDeafened ? 0 : vol;
    }
  });

  if (voiceDeafened && !voiceMuted) {
    toggleMute();
  }
}

function openVoiceChat() {
  voiceChatOpen = true;
  chatArea.classList.remove('chat-collapsed');
  document.querySelectorAll('.vc-chat-toggle-btn').forEach(btn => btn.classList.add('active'));
}

function closeVoiceChat() {
  voiceChatOpen = false;
  chatArea.classList.add('chat-collapsed');
  document.querySelectorAll('.vc-chat-toggle-btn').forEach(btn => btn.classList.remove('active'));
}

function toggleVoiceChat() {
  if (voiceChatOpen) closeVoiceChat();
  else openVoiceChat();
}

document.querySelectorAll('.vc-chat-toggle-btn').forEach(btn => {
  btn.addEventListener('click', toggleVoiceChat);
});
voiceChatCloseBtn.addEventListener('click', closeVoiceChat);

async function acquireMicStream() {
  const settings = NoiseSuppression.getSettings();
  const audioConstraints = NoiseSuppression.audioConstraints(settings);
  if (selectedAudioInputId) {
    audioConstraints.deviceId = { ideal: selectedAudioInputId };
  }

  let raw;
  try {
    raw = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
  } catch (err) {
    if (selectedAudioInputId) {
      console.warn('Could not open preferred mic, falling back to default:', err);
      raw = await navigator.mediaDevices.getUserMedia({
        audio: NoiseSuppression.audioConstraints(settings),
        video: false
      });
    } else {
      throw err;
    }
  }

  voiceRawStream = raw;
  /* A microphone re-acquired while muted (engine or device changed during a
   * call) must not go live: disabling the track here, before the chain is built,
   * is what keeps audio from reaching peers in the meantime. */
  if (voiceMuted) raw.getAudioTracks().forEach(track => { track.enabled = false; });

  // Background refresh device list since mic permissions are now active
  populateAudioDevices(false).catch(() => {});
  return buildVoiceChain(raw, settings);
}

/* Run the selected suppressor over a raw mic stream and hand back the track to
 * publish. Never throws - on failure the call gets the raw microphone. */
async function buildVoiceChain(raw, settings) {
  // First dfn3 use pulls the ~16 MB wasm engine plus a ~8 MB model; after that
  // the browser caches both and this is sub-second.
  const budget = settings.engine === 'dfn3' ? 20000 : 4000;
  let result;
  try {
    result = await Promise.race([
      NoiseSuppression.createDenoisedStream(raw, settings),
      new Promise((_, reject) => setTimeout(() => reject(new Error('init timeout')), budget))
    ]);
  } catch (err) {
    result = {
      stream: raw,
      engine: settings.engine,
      active: 'raw',
      degraded: true,
      reason: (err && err.message) || 'noise suppression failed'
    };
  }

  if (voiceNoiseChain) {
    voiceNoiseChain.stop();
    voiceNoiseChain = null;
  }
  voiceNoiseChain = result.chain || null;
  voiceNoiseActive = result.active;

  if (result.degraded) {
    vlog('noise suppression', result.engine, 'unavailable, using', result.active + ':', result.reason);
    setNoiseNotice(`Could not start ${result.engine} (${result.reason}). Using ${result.active} instead.`);
  } else {
    vlog('noise suppression active:', result.active);
    setNoiseNotice('');
  }
  return result.stream;
}

/* Re-acquire the microphone and republish it on every peer connection. Shared
 * by device changes and engine changes: both need a fresh getUserMedia because
 * the browser's own suppressor is a constraint, not a filter we can swap. */
async function refreshMicStream() {
  if (!voiceJoined) return;
  try {
    if (voiceRawStream) {
      voiceRawStream.getTracks().forEach(t => t.stop());
    }
    stopVAD();
    const newStream = await acquireMicStream();
    const oldTrack = voiceLocalStream ? voiceLocalStream.getAudioTracks()[0] : null;
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) return;
    if (voiceLocalStream && oldTrack) {
      voiceLocalStream.removeTrack(oldTrack);
      voiceLocalStream.addTrack(newTrack);
      oldTrack.stop();
    } else {
      voiceLocalStream = newStream;
    }
    Object.values(voicePeerConnections).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) sender.replaceTrack(newTrack);
    });
    startVAD(voiceLocalStream);
  } catch (err) {
    console.warn('Failed to refresh microphone stream:', err);
  }
}

async function joinVoiceChannel(listenOnly = false, targetChannelId = null) {
  const targetId = targetChannelId || currentChannelId;
  if (!targetId) return;
  const ch = channels.find(c => c.id === targetId);
  if (!ch || (ch.type !== 'voice' && ch.type !== 'dm')) return;

  if (listenOnly) {
    voiceLocalStream = createSilentAudioStream();
    voiceMuted = true;
  } else {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (await showConfirmModal({
        title: 'Microphone Unavailable',
        message: 'Microphone access is not available in this browser.\n\nWould you like to join in Listen-Only mode?',
        confirmText: 'Join Listen-Only',
        cancelText: 'Cancel'
      })) {
        return joinVoiceChannel(true, targetId);
      }
      return;
    }

    try {
      voiceLocalStream = await acquireMicStream();
    } catch (err) {
      const msg = err.name === 'NotAllowedError' ? 'Microphone permission denied.' :
                  err.name === 'NotFoundError' ? 'No microphone found.' :
                  'Could not access microphone: ' + err.message;
      if (await showConfirmModal({
        title: 'Microphone Access',
        message: `${msg}\n\nWould you like to join in Listen-Only mode?`,
        confirmText: 'Join Listen-Only',
        cancelText: 'Cancel'
      })) {
        return joinVoiceChannel(true, targetId);
      }
      return;
    }
  }

  voiceJoined = true;
  voiceChannelId = targetId;
  playSound('joined');
  voiceMuteBtn.classList.toggle('muted', voiceMuted);
  voiceMuteBtn.innerHTML = voiceMuted ? '<i class="ph ph-microphone-slash"></i>' : '<i class="ph ph-microphone"></i>';
  const sidebarMuteJoin = document.getElementById('sidebar-mute-btn');
  if (sidebarMuteJoin) {
    sidebarMuteJoin.classList.toggle('muted', voiceMuted);
    sidebarMuteJoin.innerHTML = voiceMuted ? '<i class="ph-bold ph-microphone-slash"></i>' : '<i class="ph-bold ph-microphone"></i>';
    sidebarMuteJoin.title = voiceMuted ? 'Unmute' : 'Mute';
  }

  sendWS('voice:join', { channelId: targetId });
  if (!voiceMuted) {
    startVAD(voiceLocalStream);
  }

  const channelLabelText = ch.type === 'dm' ? `@${ch.dmUser ? ch.dmUser.username : 'DM Call'}` : `#${ch.name}`;

  if (ch.type === 'voice') {
    voiceView.style.display = 'none';
  }
  voiceActiveView.style.display = 'flex';
  voiceControls.style.display = 'flex';
  voiceScreenArea.style.display = 'none';
  setVoiceActiveChannelLabel(ch);

  const voiceStatusBarJoin = document.getElementById('voice-status-bar');
  const voiceStatusChannelJoin = document.getElementById('voice-status-channel');
  if (voiceStatusBarJoin) {
    voiceStatusBarJoin.style.display = 'flex';
    if (voiceStatusChannelJoin) voiceStatusChannelJoin.textContent = channelLabelText;
  }
}

async function rejoinVoiceChannel(channelId) {
  if (!channelId) return;
  const ch = channels.find(c => c.id === channelId);
  if (!ch || (ch.type !== 'voice' && ch.type !== 'dm')) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  try {
    voiceLocalStream = await acquireMicStream();
  } catch (err) {
    console.warn('[VOICE] mic re-acquire failed after reconnect:', err.name || err.message);
    return;
  }

  voiceJoined = true;
  voiceMuted = false;
  voiceChannelId = channelId;
  voiceMuteBtn.classList.remove('muted');
  voiceMuteBtn.innerHTML = '<i class="ph ph-microphone"></i>';
  const sidebarMuteRejoin = document.getElementById('sidebar-mute-btn');
  if (sidebarMuteRejoin) {
    sidebarMuteRejoin.classList.remove('muted');
    sidebarMuteRejoin.innerHTML = '<i class="ph-bold ph-microphone"></i>';
    sidebarMuteRejoin.title = 'Mute';
  }

  sendWS('voice:join', { channelId });
  startVAD(voiceLocalStream);

  const channelLabelText = ch.type === 'dm' ? `@${ch.dmUser ? ch.dmUser.username : 'DM Call'}` : `#${ch.name}`;

  if (ch.type === 'voice') {
    voiceView.style.display = 'none';
  }
  voiceActiveView.style.display = 'flex';
  voiceControls.style.display = 'flex';
  voiceScreenArea.style.display = 'none';
  setVoiceActiveChannelLabel(ch);

  const voiceStatusBarRejoin = document.getElementById('voice-status-bar');
  const voiceStatusChannelRejoin = document.getElementById('voice-status-channel');
  if (voiceStatusBarRejoin) {
    voiceStatusBarRejoin.style.display = 'flex';
    if (voiceStatusChannelRejoin) voiceStatusChannelRejoin.textContent = channelLabelText;
  }
}

function leaveVoiceChannel(silent) {
  hideMiniplayer();

  const voiceStatusBarLeave = document.getElementById('voice-status-bar');
  if (voiceStatusBarLeave) {
    voiceStatusBarLeave.style.display = 'none';
  }
  const sidebarMuteLeave = document.getElementById('sidebar-mute-btn');
  if (sidebarMuteLeave) {
    sidebarMuteLeave.classList.remove('muted');
    sidebarMuteLeave.innerHTML = '<i class="ph-bold ph-microphone"></i>';
    sidebarMuteLeave.title = 'Mute';
  }

  if (voiceCameraOn) stopCamera();
  if (voiceScreenSharing) stopScreenShare();

  if (voiceDeafened) {
    voiceDeafened = false;
    const deafenBtns = [
      document.getElementById('voice-deafen-btn'),
      document.getElementById('miniplayer-deafen-btn'),
      document.getElementById('sidebar-deafen-btn')
    ];
    deafenBtns.forEach(btn => {
      if (btn) {
        btn.classList.remove('deafened', 'muted');
        btn.innerHTML = '<i class="ph-bold ph-headphones"></i>';
        btn.title = 'Deafen';
      }
    });
  }

  if (voiceJoined) {
    if (!silent) {
      playSound('leave');
    }
    const leavingId = voiceChannelId;
    if (leavingId && voiceParticipantsByChannel[leavingId]) {
      voiceParticipantsByChannel[leavingId] = voiceParticipantsByChannel[leavingId].filter(p => p.userId !== (currentUser && currentUser.id));
    }
    sendWS('voice:leave', { channelId: leavingId });
    voiceJoined = false;
    voiceChannelId = null;
    voiceMuted = false;
    renderChannels();
    if (leavingId) updateVoiceParticipantCount(leavingId);
  }

  stopVAD();

  if (voiceNoiseChain) {
    voiceNoiseChain.stop();
    voiceNoiseChain = null;
  }
  NoiseSuppression.dispose();

  if (voiceLocalStream) {
    voiceLocalStream.getTracks().forEach(t => t.stop());
    voiceLocalStream = null;
  }

  if (voiceRawStream) {
    voiceRawStream.getTracks().forEach(t => t.stop());
    voiceRawStream = null;
  }

  Object.keys(voicePeerConnections).forEach(userId => {
    closePeerConnection(userId);
  });
  voicePeerConnections = {};
  voiceAudioElements = {};
  voiceIceCandidateQueues = {};
  voiceRestartAttempts = {};
  remoteCameraStreams = {};
  pendingVideoKinds = {};
  focusedScreenUserId = null;
  voiceActiveView.classList.remove('share-active');

  Object.values(livestreamAudioElements).forEach(audio => {
    audio.srcObject = null;
    audio.remove();
  });
  livestreamAudioElements = {};

  voiceActiveView.style.display = 'none';
  voiceControls.style.display = 'none';

  if (currentChannelId) {
    const ch = channels.find(c => c.id === currentChannelId);
    if (ch && ch.type === 'voice') {
      voiceView.style.display = 'flex';
      voiceView.querySelector('.voice-channel-name').textContent = `${ch.name}`;
    }
  }
}

/* ── DM Calling System ─────────────────────────────────────────────────────── */
let currentActiveDmCall = null;
let currentIncomingCall = null;

async function startDmCall(channelId) {
  if (voiceJoined) {
    if (!await showConfirmModal({
      title: 'Active Voice Call',
      message: 'You are already in a voice call. Leave it to start this call?',
      confirmText: 'Leave & Call',
      cancelText: 'Cancel'
    })) {
      return;
    }
    leaveVoiceChannel(true);
  }

  const ch = channels.find(c => c.id === channelId);
  if (!ch || ch.type !== 'dm') return;

  const targetName = ch.dmUser ? ch.dmUser.username : 'User';
  const targetAvatar = ch.dmUser ? (ch.dmUser.profilePic || getDefaultAvatar(ch.dmUser.id)) : getDefaultAvatar();

  const dmCallingModal = document.getElementById('dm-calling-modal');
  const dmCallingAvatar = document.getElementById('dm-calling-avatar');
  const dmCallingUsername = document.getElementById('dm-calling-username');
  const dmCallingStatus = document.getElementById('dm-calling-status');

  if (dmCallingAvatar) dmCallingAvatar.src = targetAvatar;
  if (dmCallingUsername) dmCallingUsername.textContent = targetName;
  if (dmCallingStatus) dmCallingStatus.textContent = 'Ringing...';
  if (dmCallingModal) dmCallingModal.style.display = 'flex';

  currentActiveDmCall = { channelId, targetUserId: ch.dmUser ? ch.dmUser.id : null };
  startRingtone();
  sendWS('dm:call:start', { channelId });
}

function cancelDmCall() {
  stopRingtone();
  const dmCallingModal = document.getElementById('dm-calling-modal');
  if (dmCallingModal) dmCallingModal.style.display = 'none';

  if (currentActiveDmCall) {
    sendWS('dm:call:cancel', { channelId: currentActiveDmCall.channelId });
    currentActiveDmCall = null;
  }
}

function acceptDmCall() {
  stopRingtone();
  const dmIncomingModal = document.getElementById('dm-incoming-call-modal');
  if (dmIncomingModal) dmIncomingModal.style.display = 'none';

  if (currentIncomingCall) {
    const callChId = currentIncomingCall.channelId;
    sendWS('dm:call:accept', { channelId: callChId });
    currentIncomingCall = null;

    if (currentChannelId !== callChId) {
      switchChannel(callChId);
    }
    joinVoiceChannel(false, callChId);
  }
}

function declineDmCall() {
  stopRingtone();
  const dmIncomingModal = document.getElementById('dm-incoming-call-modal');
  if (dmIncomingModal) dmIncomingModal.style.display = 'none';

  if (currentIncomingCall) {
    sendWS('dm:call:decline', { channelId: currentIncomingCall.channelId });
    currentIncomingCall = null;
  }
}

const dmCallBtn = document.getElementById('dm-call-btn');
if (dmCallBtn) {
  dmCallBtn.addEventListener('click', () => {
    if (currentChannelId) startDmCall(currentChannelId);
  });
}

const dmCallingCancelBtn = document.getElementById('dm-calling-cancel-btn');
if (dmCallingCancelBtn) {
  dmCallingCancelBtn.addEventListener('click', cancelDmCall);
}

const dmIncomingAcceptBtn = document.getElementById('dm-incoming-accept-btn');
if (dmIncomingAcceptBtn) {
  dmIncomingAcceptBtn.addEventListener('click', acceptDmCall);
}

const dmIncomingDeclineBtn = document.getElementById('dm-incoming-decline-btn');
if (dmIncomingDeclineBtn) {
  dmIncomingDeclineBtn.addEventListener('click', declineDmCall);
}

async function toggleMute() {
  if (!voiceLocalStream) return;
  if (voiceMuted && !voiceRawStream) {
    try {
      const realStream = await acquireMicStream();
      const oldTrack = voiceLocalStream.getAudioTracks()[0];
      const newTrack = realStream.getAudioTracks()[0];
      voiceLocalStream.removeTrack(oldTrack);
      voiceLocalStream.addTrack(newTrack);
      oldTrack.stop();
      Object.values(voicePeerConnections).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (sender) sender.replaceTrack(newTrack);
      });
      startVAD(voiceLocalStream);
    } catch (err) {
      await showAlertModal({ title: 'Microphone Error', message: 'Cannot unmute: microphone is not available or permission denied.', type: 'danger' });
      return;
    }
  }

  voiceMuted = !voiceMuted;
  const muteTarget = voiceRawStream || voiceLocalStream;
  if (muteTarget) {
    muteTarget.getAudioTracks().forEach(track => {
      track.enabled = !voiceMuted;
    });
  }
  const muteBtns = [
    voiceMuteBtn,
    document.getElementById('sidebar-mute-btn')
  ];
  muteBtns.forEach(btn => {
    if (btn) {
      btn.classList.toggle('muted', voiceMuted);
      btn.innerHTML = voiceMuted ? '<i class="ph-bold ph-microphone-slash"></i>' : '<i class="ph-bold ph-microphone"></i>';
      btn.title = voiceMuted ? 'Unmute' : 'Mute';
    }
  });
  sendWS('voice:mute', { channelId: voiceChannelId, muted: voiceMuted });
}

async function toggleCamera() {
  if (voiceCameraOn) {
    stopCamera();
    return;
  }
  if (!voiceChannelId || !voiceLocalStream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    await showAlertModal({ title: 'Camera Unavailable', message: 'Camera access is not available in this browser.', type: 'warning' });
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    voiceCameraStream = stream;
    voiceCameraOn = true;
    voiceCameraBtn.classList.add('camera-on');
    voiceCameraBtn.innerHTML = '<i class="ph ph-video-camera-slash"></i>';

    const track = stream.getVideoTracks()[0];
    track.onended = () => {
      if (voiceCameraOn) stopCamera();
    };

    sendWS('voice:camera', { channelId: voiceChannelId, cameraOn: true });

    Object.keys(voicePeerConnections).forEach(userId => {
      const pc = voicePeerConnections[userId];
      if (pc) {
        pc.cameraVideoSender = pc.addTrack(track, stream);
        renegotiatePeerConnection(userId);
      }
    });

    renderVoiceParticipants_live();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      await showAlertModal({ title: 'Camera Permission Denied', message: 'Camera permission denied.\n\nAllow camera access in your browser settings for this site.', type: 'danger' });
    } else if (err.name !== 'AbortError') {
      console.error('Camera error:', err);
    }
  }
}

function stopCamera() {
  if (!voiceCameraOn) return;
  voiceCameraOn = false;
  voiceCameraBtn.classList.remove('camera-on');
  voiceCameraBtn.innerHTML = '<i class="ph ph-video-camera"></i>';

  if (voiceChannelId) {
    sendWS('voice:camera', { channelId: voiceChannelId, cameraOn: false });
  }

  Object.keys(voicePeerConnections).forEach(userId => {
    const pc = voicePeerConnections[userId];
    if (pc && pc.cameraVideoSender) {
      pc.removeTrack(pc.cameraVideoSender);
      pc.cameraVideoSender = null;
      renegotiatePeerConnection(userId);
    }
  });

  if (voiceCameraStream) {
    voiceCameraStream.getTracks().forEach(t => t.stop());
    voiceCameraStream = null;
  }

  renderVoiceParticipants_live();
}

function preferH264VideoCodec(transceiver) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
  try {
    const caps = (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities)
      ? RTCRtpSender.getCapabilities('video')
      : null;
    if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) return;
    const h264Codecs = caps.codecs.filter(c => c && c.mimeType && c.mimeType.toLowerCase() === 'video/h264');
    const otherCodecs = caps.codecs.filter(c => !c || !c.mimeType || c.mimeType.toLowerCase() !== 'video/h264');
    if (h264Codecs.length > 0) {
      transceiver.setCodecPreferences([...h264Codecs, ...otherCodecs]);
    }
  } catch (e) {
    console.warn('Could not set H264 codec preference:', e);
  }
}

function mungeSdpForHighFramerateVideo(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const lines = sdp.split('\r\n');
  const result = [];
  let inVideo = false;
  let bandwidthInserted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=video ')) {
      inVideo = true;
      bandwidthInserted = false;
      result.push(line);
      continue;
    } else if (line.startsWith('m=')) {
      inVideo = false;
    }

    if (inVideo) {
      if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) {
        continue;
      }
      if (line.startsWith('a=') && !bandwidthInserted) {
        result.push('b=AS:8000');
        result.push('b=TIAS:8000000');
        bandwidthInserted = true;
      }
      if (line.startsWith('a=fmtp:')) {
        let fmtp = line;
        if (!fmtp.includes('x-google-min-bitrate')) {
          fmtp += ';x-google-min-bitrate=3500;x-google-start-bitrate=6000;x-google-max-bitrate=8000';
        }
        result.push(fmtp);
        continue;
      }
    }
    result.push(line);
  }
  return result.join('\r\n');
}

function applyHighFpsEncodingParameters(sender) {
  if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
  try {
    const params = sender.getParameters();
    if (params && Array.isArray(params.encodings) && params.encodings.length > 0) {
      params.encodings[0].maxBitrate = 6000000;
      params.encodings[0].maxFramerate = 60;
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      params.degradationPreference = 'maintain-framerate';
      sender.setParameters(params).catch(err => {
        console.warn('Could not set sender parameters:', err);
      });
    }
  } catch (e) {
    console.warn('Error reading sender parameters:', e);
  }
}

async function toggleScreenShare() {
  if (voiceScreenSharing) {
    stopScreenShare();
    return;
  }
  if (!voiceChannelId || !voiceLocalStream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    await showAlertModal({ title: 'Screen Sharing', message: 'Screen sharing is not supported in this browser.', type: 'warning' });
    return;
  }
  try {
    const displayConstraints = {
      video: {
        cursor: 'always',
        frameRate: { ideal: 60, min: 30 },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: true
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
    } catch (constraintErr) {
      console.warn('getDisplayMedia with constraints failed, trying basic:', constraintErr);
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 } },
        audio: true
      });
    }
    voiceScreenStream = stream;
    voiceScreenStreamAudio = stream.getAudioTracks()[0] || null;
    voiceScreenSharing = true;
    pipDismissed = false;
    voiceScreenBtn.classList.add('sharing');
    showScreenPreview(stream);
    sendWS('voice:screen:start', { channelId: voiceChannelId });

    if (!screenSharersByChannel[voiceChannelId]) screenSharersByChannel[voiceChannelId] = [];
    if (!screenSharersByChannel[voiceChannelId].includes(currentUser.id)) {
      screenSharersByChannel[voiceChannelId].push(currentUser.id);
    }
    renderChannels();
    renderVoiceParticipants_live();

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = 'motion';
      }
      videoTrack.onended = () => {
        if (voiceScreenSharing) stopScreenShare();
      };
    }
    const micTrack = voiceLocalStream ? voiceLocalStream.getAudioTracks()[0] : null;

    Object.keys(voicePeerConnections).forEach(userId => {
      const pc = voicePeerConnections[userId];
      if (pc) {
        pc.screenVideoSender = pc.addTrack(videoTrack, stream);
        const transceiver = pc.getTransceivers ? pc.getTransceivers().find(t => t.sender === pc.screenVideoSender) : null;
        if (transceiver) {
          preferH264VideoCodec(transceiver);
        }
        applyHighFpsEncodingParameters(pc.screenVideoSender);
        const hasScreenAudio = pc.getSenders().some(s => s.track && s.track.kind === 'audio' && s.track !== micTrack);
        if (!hasScreenAudio && voiceScreenStreamAudio) {
          pc.screenAudioSender = pc.addTrack(voiceScreenStreamAudio, stream);
        }
        renegotiatePeerConnection(userId);
      }
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      console.error('Screen share error:', err);
    }
  }
}

function stopScreenShare() {
  if (!voiceScreenSharing) return;

  if (voiceScreenStream) {
    voiceScreenStream.getTracks().forEach(t => t.stop());
    voiceScreenStream = null;
  }
  if (voiceScreenStreamAudio) {
    voiceScreenStreamAudio.stop();
    voiceScreenStreamAudio = null;
  }

  Object.keys(voicePeerConnections).forEach(userId => {
    const pc = voicePeerConnections[userId];
    if (pc) {
      if (pc.screenVideoSender) {
        pc.removeTrack(pc.screenVideoSender);
        pc.screenVideoSender = null;
      }
      if (pc.screenAudioSender) {
        pc.removeTrack(pc.screenAudioSender);
        pc.screenAudioSender = null;
      }
      renegotiatePeerConnection(userId);
    }
  });

  voiceScreenSharing = false;
  voiceScreenBtn.classList.remove('sharing');
  voiceScreenArea.style.display = 'none';
  voiceScreenContainer.innerHTML = '';
  focusedScreenUserId = null;
  voiceActiveView.classList.remove('share-active');
  hideFloatingScreenShare();
  sendWS('voice:screen:stop', { channelId: voiceChannelId });

  if (screenSharersByChannel[voiceChannelId]) {
    screenSharersByChannel[voiceChannelId] = screenSharersByChannel[voiceChannelId].filter(id => id !== currentUser.id);
  }
  renderChannels();
  renderVoiceParticipants_live();
}

function showScreenPreview(stream) {
  voiceScreenLabel.textContent = voiceScreenStreamAudio
    ? 'Your Screen (shared audio)'
    : 'Your Screen (no shared audio)';
  voiceScreenContainer.innerHTML = '';
  const video = document.createElement('video');
  video.className = 'voice-screen-video';
  video.dataset.screenUser = currentUser.id;
  video.srcObject = stream;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  voiceScreenContainer.appendChild(video);
  video.play().catch(e => console.warn('Preview play failed:', e));
  voiceScreenStopBtn.style.display = 'inline-block';
  voiceScreenArea.style.display = 'flex';
  applyScreenFocus();
}

function takePendingVideoKind(userId) {
  const q = pendingVideoKinds[userId];
  if (q && q.length) return q.shift();
  const sharer = (screenSharersByChannel[voiceChannelId] || []).includes(userId);
  const hasScreen = !!document.getElementById(`vs-${userId}`);
  if (sharer && !hasScreen) return 'screen';
  const room = voiceParticipantsByChannel[voiceChannelId] || [];
  const p = room.find(x => x.userId === userId);
  if (p && p.cameraOn) return 'camera';
  return 'screen';
}

function attachRemoteCamera(userId, stream) {
  remoteCameraStreams[userId] = stream;
  renderVoiceParticipants_live();
}

function attachRemoteScreen(userId, stream) {
  let video = document.getElementById(`vs-${userId}`);
  if (!video) {
    video = document.createElement('video');
    video.id = `vs-${userId}`;
    video.className = 'voice-screen-video';
    voiceScreenContainer.appendChild(video);
  }
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.dataset.screenUser = userId;
  video.style.display = String(focusedScreenUserId) === String(userId) ? 'block' : 'none';
  video.srcObject = stream;

  const playVideo = () => {
    video.play().catch(e => console.warn('Remote screen play failed:', e));
  };
  playVideo();
  video.onloadedmetadata = () => {
    playVideo();
  };
  stream.getVideoTracks().forEach(track => {
    track.onunmute = () => {
      playVideo();
    };
  });

  const room = voiceParticipantsByChannel[voiceChannelId] || [];
  const p = room.find(x => x.userId === userId);
  const username = (p && p.username) ? p.username : 'User';
  voiceScreenLabel.textContent = `${username}'s Screen`;

  voiceScreenStopBtn.style.display = 'none';
  if (String(focusedScreenUserId) === String(userId) && voiceChannelId && voiceJoined) {
    voiceScreenArea.style.display = 'flex';
  }

  // Request zero display buffering and minimal jitter buffer for 60fps real-time fluidity
  const pc = voicePeerConnections[userId];
  if (pc && typeof pc.getReceivers === 'function') {
    pc.getReceivers().forEach(receiver => {
      if (receiver.track && receiver.track.kind === 'video') {
        if ('playoutDelayHint' in receiver) {
          try { receiver.playoutDelayHint = 0; } catch (_) {}
        }
        if ('jitterBufferTarget' in receiver) {
          try { receiver.jitterBufferTarget = 0; } catch (_) {}
        }
      }
    });
  }

  applyScreenFocus();
  renderVoiceParticipants_live();
}

function applyScreenFocus() {
  const videos = voiceScreenContainer.querySelectorAll('video');
  const hasShares = voiceScreenSharing || hasAnyScreenShare();
  if (hasShares) {
    voiceActiveView.classList.add('share-active');
  } else {
    voiceActiveView.classList.remove('share-active');
  }
  if (focusedScreenUserId &&
      !voiceScreenContainer.querySelector(`video[data-screen-user="${focusedScreenUserId}"]`)) {
    focusedScreenUserId = null;
  }
  videos.forEach(v => {
    const uid = v.dataset.screenUser;
    const show = focusedScreenUserId
      ? String(uid) === String(focusedScreenUserId)
      : String(uid) === String(currentUser.id);
    v.style.display = show ? 'block' : 'none';
  });
}

function renegotiatePeerConnection(userId) {
  const pc = voicePeerConnections[userId];
  if (!pc || !voiceChannelId) return;
  if (pc.signalingState !== 'stable') {
    pc._pendingRenegotiate = true;
    return;
  }
  pc.makingOffer = true;
  pc.createOffer().then(offer => {
    const mungedSdp = mungeSdpForHighFramerateVideo(offer.sdp);
    const mungedOffer = (typeof RTCSessionDescription !== 'undefined')
      ? new RTCSessionDescription({ type: offer.type, sdp: mungedSdp })
      : { type: offer.type, sdp: mungedSdp };
    return pc.setLocalDescription(mungedOffer);
  }).then(() => {
    pc.makingOffer = false;
    if (voiceChannelId) {
      sendWS('voice:offer', {
        channelId: voiceChannelId,
        targetUserId: userId,
        sdp: pc.localDescription
      });
    }
  }).catch(e => {
    pc.makingOffer = false;
    console.error('Renegotiation error:', e);
  });
}

function renderVoiceParticipants(participants) {
  voiceParticipantsEl.innerHTML = '';
  const channelSharers = screenSharersByChannel[voiceChannelId] || [];
  participants.forEach(p => {
    const tile = document.createElement('div');
    tile.className = 'voice-tile';
    tile.id = `vp-${p.userId}`;

    const avatarUrl = getUserAvatarUrl(p);
    const avatarHtml = `<img src="${avatarUrl}" alt="${escapeHtml(p.username)}">`;

    const isMe = p.userId === currentUser.id;
    const isSharing = channelSharers.includes(p.userId);
    const isMuted = p.muted === true;
    const camStream = isMe ? (voiceCameraOn ? voiceCameraStream : null) : (remoteCameraStreams[p.userId] || null);
    const statusText = isMe ? (voiceMuted ? 'Muted' : 'Talking') : (isMuted ? 'Muted' : 'Connected');
    const statusClass = (isMe && voiceMuted) || (!isMe && isMuted) ? 'muted' : '';

    const liveIcon = isSharing ? '<span class="live-indicator"><span class="live-dot"></span> LIVE</span>' : '';
    const muteIcon = isMuted && !isMe ? '<span class="voice-mute-icon" title="Muted"><i class="ph ph-mic-x"></i></span>' : '';

    let viewBtn = '';
    if (isSharing && !isMe) {
      const isViewing = String(focusedScreenUserId) === String(p.userId);
      if (isViewing) {
        viewBtn = `<button class="view-screen-btn stop" onclick="event.stopPropagation(); stopViewingScreen('${p.userId}')">Stop watching</button>`;
      } else {
        viewBtn = `<button class="view-screen-btn" onclick="event.stopPropagation(); startViewingScreen('${p.userId}')">Watch stream</button>`;
      }
    }

    tile.innerHTML = `
      <div class="voice-tile-avatar user-avatar">${camStream ? '' : avatarHtml}${muteIcon}</div>
      <div class="voice-tile-name">${escapeHtml(p.username)}${isMe ? ' (you)' : ''}</div>
      <span class="voice-participant-status ${statusClass}">${statusText}</span>
      ${liveIcon}
      ${viewBtn}
    `;

    if (camStream) {
      const avatarWrap = tile.querySelector('.voice-tile-avatar');
      if (avatarWrap) {
        const camVideo = document.createElement('video');
        camVideo.className = 'voice-tile-camera';
        camVideo.autoplay = true;
        camVideo.muted = true;
        camVideo.playsInline = true;
        if (isMe) camVideo.style.transform = 'scaleX(-1)';
        camVideo.srcObject = camStream;
        avatarWrap.prepend(camVideo);
        tile.classList.add('camera-on');
      }
    }

    if (isSharing) {
      tile.style.cursor = 'pointer';
      tile.title = isMe ? 'Toggle focus on your screen' : 'Focus this screen';
      tile.addEventListener('click', () => {
        if (String(focusedScreenUserId) === String(p.userId)) {
          stopViewingScreen(p.userId);
        } else {
          startViewingScreen(p.userId);
        }
      });
    } else if (!isMe) {
      tile.style.cursor = 'pointer';
      tile.addEventListener('click', () => {
        const audio = voiceAudioElements[p.userId];
        if (audio) {
          audio.play().catch(e => console.warn('Retry play failed:', e));
        }
      });
    }

    if (!isMe) {
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentVol = userVolumes[p.userId] !== undefined ? userVolumes[p.userId] : 1.0;
        const items = [
          { type: 'header', label: p.username },
          {
            type: 'slider',
            label: 'User Volume',
            value: currentVol,
            onInput: (val) => {
              setParticipantVolume(p.userId, val);
            }
          }
        ];
        showContextMenu(e.clientX, e.clientY, items);
      });
    }

    voiceParticipantsEl.appendChild(tile);
  });

  const ch = channels.find(c => c.id === voiceChannelId);
  if (ch && voiceView.style.display !== 'none') {
    voiceView.querySelector('.voice-channel-name').textContent = `${ch.name}`;
  }
}

function renderVoiceParticipants_live() {
  if (voiceJoined && voiceChannelId) {
    const parts = voiceParticipantsByChannel[voiceChannelId] || [];
    renderVoiceParticipants(parts);
  }
}

function startViewingScreen(userId) {
  pipDismissed = false;
  if (voiceChannelId && currentChannelId !== voiceChannelId) {
    switchChannel(voiceChannelId);
  }
  focusedScreenUserId = userId;
  voiceScreenArea.style.display = 'flex';
  const room = voiceParticipantsByChannel[voiceChannelId] || [];
  const p = room.find(x => x.userId === userId);
  const username = (p && p.username) ? p.username : 'User';
  voiceScreenLabel.textContent = `${username}'s Screen`;
  voiceScreenStopBtn.style.display = 'none';
  const video = voiceScreenContainer.querySelector(`video[data-screen-user="${userId}"]`);
  if (video) {
    video.style.display = 'block';
    video.play().catch(e => console.warn('Play screen failed:', e));
  }
  applyScreenFocus();
  renderVoiceParticipants_live();
}

function stopViewingScreen(userId) {
  if (focusedScreenUserId === userId) focusedScreenUserId = null;
  if (userId !== currentUser.id) {
    const video = voiceScreenContainer.querySelector(`video[data-screen-user="${userId}"]`);
    if (video) video.style.display = 'none';
  }
  applyScreenFocus();
  if (!voiceScreenSharing && !hasAnyScreenShare()) {
    voiceScreenArea.style.display = 'none';
    hideFloatingScreenShare();
  }
  renderVoiceParticipants_live();
}

/* Voice Activity Detection */

function startVAD(stream) {
  try {
    voiceAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = voiceAudioContext.createMediaStreamSource(stream);
    voiceAnalyser = voiceAudioContext.createAnalyser();
    voiceAnalyser.fftSize = 512;
    voiceAnalyser.smoothingTimeConstant = 0.3;
    source.connect(voiceAnalyser);
    const buf = new Uint8Array(voiceAnalyser.frequencyBinCount);
    const THRESHOLD = 15;
    let lastSpeakingTime = 0;

    function tick() {
      voiceVadFrame = requestAnimationFrame(tick);
      if (voiceMuted) {
        if (voiceIsSpeaking) {
          voiceIsSpeaking = false;
          setSpeakingLocal(false);
        }
        return;
      }
      voiceAnalyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const avg = sum / buf.length;
      const rawSpeaking = avg > THRESHOLD;
      const now = Date.now();
      if (rawSpeaking) {
        lastSpeakingTime = now;
      }
      const isSpeakingWithHangover = rawSpeaking || (now - lastSpeakingTime < 350);
      if (isSpeakingWithHangover !== voiceIsSpeaking) {
        voiceIsSpeaking = isSpeakingWithHangover;
        setSpeakingLocal(isSpeakingWithHangover);
      }
    }
    tick();
  } catch (e) {
    console.warn('VAD init failed:', e);
  }
}

function stopVAD() {
  if (voiceVadFrame) { cancelAnimationFrame(voiceVadFrame); voiceVadFrame = null; }
  if (voiceAudioContext) { voiceAudioContext.close().catch(() => { }); voiceAudioContext = null; }
  voiceAnalyser = null;
  voiceIsSpeaking = false;
}

function setSpeakingLocal(speaking) {
  // Update own avatar
  if (currentUser) {
    const el = document.getElementById(`vp-${currentUser.id}`);
    if (el) {
      const avatar = el.querySelector('.user-avatar');
      if (avatar) avatar.classList.toggle('speaking', speaking);
    }
  }
  // Notify others
  if (voiceChannelId) {
    sendWS('voice:speaking', { channelId: voiceChannelId, speaking });
  }
}

function attachRemoteAudio(userId, stream) {
  // Remove old element if any
  if (voiceAudioElements[userId]) {
    voiceAudioElements[userId].srcObject = null;
    voiceAudioElements[userId].remove();
  }

  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.id = `remote-audio-${userId}`;
  audio.srcObject = stream;
  const savedVol = (userVolumes[userId] !== undefined) ? userVolumes[userId] : 1.0;
  audio.volume = voiceDeafened ? 0 : savedVol;

  if (selectedAudioOutputId && typeof audio.setSinkId === 'function') {
    audio.setSinkId(selectedAudioOutputId).catch(err => console.warn('setSinkId remote audio failed:', err));
  }

  // Add click handler for this specific audio element
  audio.addEventListener('click', () => {
    audio.play().catch(e => console.warn('Audio play retry failed:', e));
  });

  // Must be in the DOM for some browsers to play
  document.body.appendChild(audio);
  voiceAudioElements[userId] = audio;

  // Try to play, but don't block if it fails
  audio.play().catch(err => {
    console.log('Remote audio autoplay blocked, click participant to enable:', userId);
    // Show visual indicator on the participant
    const el = document.getElementById(`vp-${userId}`);
    if (el) {
      const status = el.querySelector('.voice-participant-status');
      if (status) {
        status.textContent = '🔇 Click to hear';
        status.style.color = 'var(--text-muted)';
      }
    }
  });

  // Also set up a handler for when audio becomes playable
  audio.addEventListener('canplaythrough', () => {
    audio.play().catch(() => { });
  });
}

function attachRemoteScreenAudio(userId, stream) {
  const existing = livestreamAudioElements[userId];
  if (existing) {
    existing.srcObject = null;
    existing.remove();
  }
  const audio = document.createElement('audio');
  audio.id = `livestream-audio-${userId}`;
  audio.srcObject = stream;
  audio.muted = livestreamMutedByUser[userId] !== false;
  audio.playsInline = true;

  if (selectedAudioOutputId && typeof audio.setSinkId === 'function') {
    audio.setSinkId(selectedAudioOutputId).catch(err => console.warn('setSinkId livestream audio failed:', err));
  }

  document.body.appendChild(audio);
  livestreamAudioElements[userId] = audio;
  audio.play().catch(() => { });
  updateLivestreamMuteIcons();
}

function setLivestreamMuted(muted) {
  Object.keys(livestreamAudioElements).forEach(userId => {
    const audio = livestreamAudioElements[userId];
    audio.muted = muted;
    livestreamMutedByUser[userId] = muted;
    if (!muted) audio.play().catch(() => { });
  });
  updateLivestreamMuteIcons();
}

function toggleLivestreamMute() {
  const audios = Object.values(livestreamAudioElements);
  if (audios.length === 0) return;
  setLivestreamMuted(!audios[0].muted);
}

function updateLivestreamMuteIcons() {
  const audios = Object.values(livestreamAudioElements);
  const allMuted = audios.length === 0 || audios.every(a => a.muted);
  document.querySelectorAll('.livestream-mute-btn').forEach(btn => {
    btn.classList.toggle('muted', allMuted);
    btn.innerHTML = allMuted ? '<i class="ph ph-speaker-x"></i>' : '<i class="ph ph-speaker-high"></i>';
  });
}

function removeLivestreamAudio(userId) {
  const audio = livestreamAudioElements[userId];
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    delete livestreamAudioElements[userId];
  }
  updateLivestreamMuteIcons();
}

function flushIceCandidateQueue(userId, pc) {
  const queue = voiceIceCandidateQueues[userId];
  if (!queue) return;
  queue.forEach(c => {
    pc.addIceCandidate(new RTCIceCandidate(c)).catch(e => console.warn('Queued ICE error:', e));
  });
  delete voiceIceCandidateQueues[userId];
}

const MAX_ICE_RESTARTS = 2;

function scheduleIceRecovery(userId) {
  const key = String(userId);
  const attempts = voiceRestartAttempts[key] || 0;
  const pc = voicePeerConnections[userId];
  if (!pc) return;

  if (attempts >= MAX_ICE_RESTARTS) {
    vlog('rebuilding peer connection for', userId, 'after', attempts, 'restarts');
    const info = voiceParticipantsByChannel[voiceChannelId]
      ? voiceParticipantsByChannel[voiceChannelId].find(p => p.userId === userId)
      : null;
    const name = (info && info.username) || pc._username || 'peer';
    closePeerConnection(userId);
    voiceRestartAttempts[key] = 0;
    createPeerConnection(userId, name, currentUser.id < userId);
    return;
  }

  voiceRestartAttempts[key] = attempts + 1;
  vlog('ice restart attempt', attempts + 1, 'for', userId);
  if (typeof pc.restartIce === 'function') {
    try { pc.restartIce(); } catch (_) {}
  }
  renegotiatePeerConnection(userId);
}

function createPeerConnection(userId, username, initiator) {
  if (userId === currentUser.id) return null;
  if (voicePeerConnections[userId]) return voicePeerConnections[userId];
  closePeerConnection(userId, { keepIceQueue: true });

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 1
  });

  voicePeerConnections[userId] = pc;
  pc._username = username;
  pc.polite = currentUser.id.localeCompare(String(userId)) < 0;
  pc.makingOffer = false;
  pc.ignoreOffer = false;
  pc.isSettingRemoteAnswerPending = false;
  pc._restartTimer = null;

  if (voiceLocalStream) {
    voiceLocalStream.getTracks().forEach(track => {
      pc.addTrack(track, voiceLocalStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate && voiceChannelId) {
      sendWS('voice:ice-candidate', {
        channelId: voiceChannelId,
        targetUserId: userId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    if (event.track.kind === 'video') {
      if (takePendingVideoKind(userId) === 'camera') {
        attachRemoteCamera(userId, stream);
      } else {
        attachRemoteScreen(userId, stream);
      }
    } else {
      const isScreenAudio = event.streams && event.streams[0] && event.streams[0].getVideoTracks().length > 0;
      if (isScreenAudio) {
        attachRemoteScreenAudio(userId, event.streams[0]);
      } else {
        attachRemoteAudio(userId, stream);
      }
    }
  };

  pc.onconnectionstatechange = () => {
    vlog(userId, 'connection:', pc.connectionState, 'ice:', pc.iceConnectionState);
    if (pc.connectionState === 'failed') {
      scheduleIceRecovery(userId);
    } else if (pc.connectionState === 'disconnected') {
      if (pc._restartTimer) clearTimeout(pc._restartTimer);
      pc._restartTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected') {
          vlog(userId, 'still disconnected after grace period, restarting ICE');
          scheduleIceRecovery(userId);
        }
      }, 10000);
    } else if (pc.connectionState === 'connected') {
      voiceRestartAttempts[String(userId)] = 0;
      if (pc._restartTimer) {
        clearTimeout(pc._restartTimer);
        pc._restartTimer = null;
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    vlog(userId, 'ice state:', pc.iceConnectionState);
  };

  if (initiator) {
    renegotiatePeerConnection(userId);
  }
  return pc;
}

async function handleVoiceOffer(userId, sdp) {
  const pc = createPeerConnection(userId, 'peer', false);
  if (!pc) return;

  const readyForOffer = !pc.makingOffer && (pc.signalingState === 'stable' || pc.isSettingRemoteAnswerPending);
  const offerCollision = !readyForOffer;
  pc.ignoreOffer = !pc.polite && offerCollision;
  if (pc.ignoreOffer) {
    vlog(userId, 'Ignoring offer due to collision');
    return;
  }

  try {
    if (offerCollision && pc.polite) {
      await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }),
        pc.setRemoteDescription(new RTCSessionDescription(sdp))
      ]);
    } else {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }

    if (pc.signalingState === 'stable') return;
    flushIceCandidateQueue(userId, pc);
    const answer = await pc.createAnswer();
    const mungedSdp = mungeSdpForHighFramerateVideo(answer.sdp);
    const mungedAnswer = (typeof RTCSessionDescription !== 'undefined')
      ? new RTCSessionDescription({ type: answer.type, sdp: mungedSdp })
      : { type: answer.type, sdp: mungedSdp };
    await pc.setLocalDescription(mungedAnswer);
    if (voiceChannelId) {
      sendWS('voice:answer', {
        channelId: voiceChannelId,
        targetUserId: userId,
        sdp: pc.localDescription
      });
    }
    if (pc._pendingRenegotiate) {
      pc._pendingRenegotiate = false;
      renegotiatePeerConnection(userId);
    }
  } catch (e) {
    console.error('Answer error:', e);
  }
}

function handleVoiceAnswer(userId, sdp) {
  const pc = voicePeerConnections[userId];
  if (!pc) return;
  pc.isSettingRemoteAnswerPending = true;
  pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(() => {
    pc.isSettingRemoteAnswerPending = false;
    flushIceCandidateQueue(userId, pc);
    if (pc.screenVideoSender) {
      applyHighFpsEncodingParameters(pc.screenVideoSender);
    }
    if (pc._pendingRenegotiate) {
      pc._pendingRenegotiate = false;
      renegotiatePeerConnection(userId);
    }
  }).catch(e => {
    pc.isSettingRemoteAnswerPending = false;
    console.error('Set remote error:', e);
  });
}

function handleVoiceIceCandidate(userId, candidate) {
  const pc = voicePeerConnections[userId];
  // Queue candidates that arrive before remote description is set
  if (!pc || !pc.remoteDescription) {
    if (!voiceIceCandidateQueues[userId]) voiceIceCandidateQueues[userId] = [];
    voiceIceCandidateQueues[userId].push(candidate);
    return;
  }
  pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn('ICE error:', e));
}

function closePeerConnection(userId, opts) {
  const keepIceQueue = !!(opts && opts.keepIceQueue);
  const pc = voicePeerConnections[userId];
  if (pc) {
    if (pc._restartTimer) clearTimeout(pc._restartTimer);
    pc.close();
    delete voicePeerConnections[userId];
  }
  delete voiceRestartAttempts[String(userId)];
  // Clean up audio element
  const audio = voiceAudioElements[userId];
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    delete voiceAudioElements[userId];
  }
  // Clean up livestream audio element
  const liveAudio = livestreamAudioElements[userId];
  if (liveAudio) {
    liveAudio.srcObject = null;
    liveAudio.remove();
    delete livestreamAudioElements[userId];
  }
  // Clean up screen video element
  const screenEl = document.getElementById(`vs-${userId}`);
  if (screenEl) {
    screenEl.srcObject = null;
    screenEl.remove();
  }
  if (!keepIceQueue) delete voiceIceCandidateQueues[userId];
  delete pendingVideoKinds[userId];
  delete remoteCameraStreams[userId];
  const el = document.getElementById(`vp-${userId}`);
  if (el) el.remove();
}

/* Miniplayer */

function showMiniplayer() {
  const ch = channels.find(c => c.id === voiceChannelId);
  if (!ch || !voiceJoined) return;
  miniplayerChannelName.textContent = `#${ch.name}`;
  miniplayer.style.display = 'flex';
  miniplayerMuteBtn.innerHTML = voiceMuted ? '<i class="ph ph-microphone-slash"></i>' : '<i class="ph ph-microphone"></i>';
  miniplayerMuteBtn.classList.toggle('muted', voiceMuted);
  miniplayerVisible = true;
}

function hideMiniplayer() {
  miniplayer.style.display = 'none';
  miniplayerVisible = false;
}

function updateMiniplayer() {
  if (voiceJoined && document.hidden) {
    showMiniplayer();
  } else {
    hideMiniplayer();
  }
}

document.addEventListener('visibilitychange', updateMiniplayer);
window.addEventListener('blur', updateMiniplayer);
window.addEventListener('focus', hideMiniplayer);

miniplayerMuteBtn.addEventListener('click', toggleMute);
miniplayerLeaveBtn.addEventListener('click', () => leaveVoiceChannel(false));

/* ==========================================================================
   Voice & Audio Device Management
   ========================================================================== */

function openVoiceSettingsModal() {
  if (!voiceSettingsModal) return;
  voiceSettingsModal.style.display = 'flex';
  populateAudioDevices(true);
}

function closeVoiceSettingsModal() {
  if (!voiceSettingsModal) return;
  voiceSettingsModal.style.display = 'none';
  stopMicTest();
}

async function populateAudioDevices(requestPermission = false) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return;
  }

  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    console.warn('enumerateDevices failed:', err);
    return;
  }

  const hasLabels = devices.some(d => (d.kind === 'audioinput' || d.kind === 'audiooutput') && d.label);
  let shouldPrompt = requestPermission;
  if (!hasLabels && !shouldPrompt && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
    shouldPrompt = true;
  }
  if (!hasLabels && shouldPrompt) {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      tempStream.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      console.warn('Microphone permission not granted yet for device labels:', e);
    }
  }

  const audioInputs = devices.filter(d => d.kind === 'audioinput');
  const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

  // Input selects
  const inputSelects = [
    document.getElementById('voice-modal-input-select'),
    document.getElementById('settings-voice-input-select')
  ];

  inputSelects.forEach(select => {
    if (!select) return;
    select.innerHTML = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default Microphone';
    select.appendChild(defaultOpt);

    let micIdx = 1;
    audioInputs.forEach(device => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `Microphone ${micIdx++}`;
      select.appendChild(opt);
    });

    if (selectedAudioInputId && Array.from(select.options).some(o => o.value === selectedAudioInputId)) {
      select.value = selectedAudioInputId;
    } else {
      select.value = '';
    }
  });

  // Output selects
  const outputSelects = [
    document.getElementById('voice-modal-output-select'),
    document.getElementById('settings-voice-output-select')
  ];

  const supportsSetSinkId = typeof HTMLMediaElement.prototype.setSinkId === 'function';

  outputSelects.forEach(select => {
    if (!select) return;
    select.innerHTML = '';

    if (!supportsSetSinkId) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Default (System Managed)';
      select.appendChild(opt);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default Speaker';
    select.appendChild(defaultOpt);

    let spkIdx = 1;
    audioOutputs.forEach(device => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `Speaker ${spkIdx++}`;
      select.appendChild(opt);
    });

    if (selectedAudioOutputId && Array.from(select.options).some(o => o.value === selectedAudioOutputId)) {
      select.value = selectedAudioOutputId;
    } else {
      select.value = '';
    }
  });

  const notices = [
    document.getElementById('voice-modal-output-notice'),
    document.getElementById('settings-voice-output-notice')
  ];
  notices.forEach(n => {
    if (!n) return;
    if (!supportsSetSinkId) {
      n.textContent = 'Speaker switching not supported by browser';
      n.style.display = 'inline';
    } else {
      n.style.display = 'none';
    }
  });
}

function syncAudioDeviceSelects() {
  const inputSelects = [
    document.getElementById('voice-modal-input-select'),
    document.getElementById('settings-voice-input-select')
  ];
  inputSelects.forEach(s => {
    if (s) s.value = selectedAudioInputId || '';
  });

  const outputSelects = [
    document.getElementById('voice-modal-output-select'),
    document.getElementById('settings-voice-output-select')
  ];
  outputSelects.forEach(s => {
    if (s) s.value = selectedAudioOutputId || '';
  });
}

async function changeAudioInputDevice(deviceId) {
  selectedAudioInputId = deviceId;
  try {
    localStorage.setItem('mellow_audio_input_id', deviceId);
  } catch (e) {}
  syncAudioDeviceSelects();

  if (isTestingMic) {
    startMicTest();
  }

  if (voiceJoined && !voiceMuted) {
    try {
      await refreshMicStream();
    } catch (err) {
      console.warn('Failed to switch microphone during call:', err);
    }
  }
}

async function changeAudioOutputDevice(deviceId) {
  selectedAudioOutputId = deviceId;
  try {
    localStorage.setItem('mellow_audio_output_id', deviceId);
  } catch (e) {}
  syncAudioDeviceSelects();

  // Apply to participant audio streams
  for (const audio of Object.values(voiceAudioElements)) {
    if (audio && typeof audio.setSinkId === 'function') {
      try {
        await audio.setSinkId(deviceId);
      } catch (err) {
        console.warn('Failed to setSinkId on participant audio:', err);
      }
    }
  }

  // Apply to screen share audio streams
  for (const audio of Object.values(livestreamAudioElements)) {
    if (audio && typeof audio.setSinkId === 'function') {
      try {
        await audio.setSinkId(deviceId);
      } catch (err) {
        console.warn('Failed to setSinkId on livestream audio:', err);
      }
    }
  }

  // Apply to sound effect AudioContext
  if (soundCtx && typeof soundCtx.setSinkId === 'function') {
    try {
      await soundCtx.setSinkId(deviceId);
    } catch (e) {
      console.warn('Failed to setSinkId on soundCtx:', e);
    }
  }
}

/* ---------------------------- Noise suppression ----------------------------
 * Settings live in two places (the app Settings modal and the in-call voice
 * modal), same dual-id convention as the audio device selects. */

const NOISE_UI_SCOPES = ['settings', 'voice-modal'];
let noiseOverloadReports = 0;
let noiseSwitchInFlight = false;

function noiseEls(suffix) {
  return NOISE_UI_SCOPES
    .map(scope => document.getElementById(`${scope}-noise-${suffix}`))
    .filter(Boolean);
}

function noiseEngineDef(id) {
  const wanted = id || NoiseSuppression.getSettings().engine;
  return NoiseSuppression.ENGINES.find(e => e.id === wanted) || NoiseSuppression.ENGINES[0];
}

function updateNoiseStrengthLabel() {
  const def = noiseEngineDef();
  const value = def.hasStrength ? NoiseSuppression.strengthFor(def.id) + '%' : 'not adjustable';
  noiseEls('strength-value').forEach(el => { el.textContent = value; });
}

function updateNoiseHint() {
  const def = noiseEngineDef();
  let hint = def.hint;
  if (def.id === 'dfn3' && navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4) {
    hint += ' Detected a low core count: this engine may glitch on your hardware.';
  }
  noiseEls('hint').forEach(el => { el.textContent = hint; });
}

function setNoiseNotice(text) {
  noiseEls('notice').forEach(el => {
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
  });
}

function updateNoiseLoadReadout(s) {
  if (!s) return;
  const budget = s.budgetMs || 10;
  // Chrome exposes no `performance` inside an AudioWorkletGlobalScope, so per-ms
  // cost is often unavailable. Gaps in the output are the signal that always
  // works, and they are what actually matters: they are audible.
  const gaps = (s.drops || 0) + (s.starves || 0);
  const parts = [];
  if (Number.isFinite(s.avgMs) && s.avgMs > 0) {
    parts.push(`${Math.round((s.avgMs / budget) * 100)}% of one core (${s.avgMs} ms per ${budget} ms frame)`);
  }
  if (gaps >= 8) parts.push(`${gaps} audio gaps in the last ${s.frames || '?'} frames`);
  const text = parts.length ? `Engine load: ${parts.join(', ')}` : '';
  noiseEls('load').forEach(el => {
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  });
}

function syncNoiseUI(settings) {
  const s = settings || NoiseSuppression.getSettings();
  const def = noiseEngineDef(s.engine);
  const value = NoiseSuppression.strengthFor(s.engine, s);
  noiseEls('engine-select').forEach(select => { select.value = s.engine; });
  noiseEls('strength').forEach(range => {
    range.value = value;
    range.disabled = !def.hasStrength;
    range.title = def.hasStrength ? 'Noise suppression strength' : 'Not adjustable for this engine';
  });
  updateNoiseStrengthLabel();
  updateNoiseHint();
}

function changeNoiseStrength(value) {
  const def = noiseEngineDef();
  if (!def.hasStrength) return;
  const strength = NoiseSuppression.clampStrength(value);
  NoiseSuppression.setStrength(def.id, strength);
  noiseEls('strength').forEach(range => { range.value = strength; });
  updateNoiseStrengthLabel();
  // In-place and glitch free: a message to the worklet, no track swap and no
  // renegotiation. Each running chain gets the value stored for its own engine.
  NoiseSuppression.eachNode(chain => {
    NoiseSuppression.applyStrength(chain.node, chain.engine, NoiseSuppression.strengthFor(chain.engine));
  });
}

async function changeNoiseEngine(engine) {
  if (!NoiseSuppression.ENGINES.some(e => e.id === engine)) return;
  const settings = NoiseSuppression.setEngine(engine);
  syncNoiseUI(settings);
  noiseEls('load').forEach(el => { el.style.display = 'none'; });

  if (engine === 'dfn3') {
    setNoiseNotice('Loading DeepFilterNet3 - about 24 MB of engine and model is fetched once and then cached by the browser.');
    NoiseSuppression.warmup('dfn3').then(ok => {
      if (!ok) setNoiseNotice('DeepFilterNet3 assets are missing from public/js/lib/dfn3/. Restore them, or pick another engine.');
    });
  } else {
    setNoiseNotice('');
  }

  if (!voiceJoined) {
    // Nothing is streaming, so release the shared context (and with it the ~29 MB
    // the dfn3 model holds on the audio thread). A joined call must never be
    // disposed here: that would silence the track already published to peers.
    NoiseSuppression.dispose();
    return;
  }
  if (noiseSwitchInFlight) return;
  noiseSwitchInFlight = true;
  try {
    vlog('noise suppression switching to', engine);
    await refreshMicStream();
  } finally {
    noiseSwitchInFlight = false;
  }
}

function handleNoiseStats(s) {
  updateNoiseLoadReadout(s);
  if (!s || s.engine !== 'dfn3' || !voiceJoined) {
    noiseOverloadReports = 0;
    return;
  }
  // Two independent proofs the engine cannot keep up with real time: a frame
  // costing more than 6 of its 10 ms budget, or the ring buffers dropping and
  // starving (the audio thread has no clock, so gaps are the portable signal).
  const slow = Number.isFinite(s.avgMs) && s.avgMs > 6;
  const gaps = (s.drops || 0) + (s.starves || 0);
  const starving = gaps >= 24;
  if (!slow && !starving) {
    noiseOverloadReports = 0;
    return;
  }
  noiseOverloadReports++;
  if (noiseOverloadReports < 2) return;
  // Two consecutive reports: the audio thread is losing. Downgrade audibly
  // rather than shipping clipped, stuttering voice.
  noiseOverloadReports = 0;
  const why = slow
    ? `${s.avgMs} ms per ${s.budgetMs || 10} ms frame`
    : `${gaps} dropped or starved frames per 2 s`;
  vlog('dfn3 cannot keep up:', why, '- falling back to RNNoise');
  NoiseSuppression.setEngine('rnnoise');
  setNoiseNotice(`DeepFilterNet3 could not keep up with your audio thread (${why}), so RNNoise is being used instead.`);
  syncNoiseUI();
  refreshMicStream();
}

function initNoiseSuppressionUI() {
  // main.js is also loaded under a minimal Node shim by the UI tests, which does
  // not provide the engine layer. Building this UI needs nothing else at startup.
  if (typeof NoiseSuppression === 'undefined') return;
  noiseEls('engine-select').forEach(select => {
    select.innerHTML = '';
    NoiseSuppression.ENGINES.forEach(engine => {
      const opt = document.createElement('option');
      opt.value = engine.id;
      opt.textContent = engine.label;
      select.appendChild(opt);
    });
    select.addEventListener('change', e => changeNoiseEngine(e.target.value));
  });
  noiseEls('strength').forEach(range => {
    range.min = '0';
    range.max = '100';
    range.step = '1';
    range.addEventListener('input', e => changeNoiseStrength(e.target.value));
  });
  NoiseSuppression.setStatsHandler(handleNoiseStats);
  syncNoiseUI();
}

async function startMicTest() {
  stopMicTest();
  try {
    const settings = NoiseSuppression.getSettings();
    const audioConstraints = NoiseSuppression.audioConstraints(settings);
    if (selectedAudioInputId) {
      audioConstraints.deviceId = { ideal: selectedAudioInputId };
    }

    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (e1) {
      raw = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    micTestStream = raw;

    // Meter the suppressed signal, so the strength slider can be tuned against
    // something real. Falls back to the raw mic when the engine cannot start.
    let metered = raw;
    if (settings.engine === 'rnnoise' || settings.engine === 'dfn3') {
      const chained = await NoiseSuppression.createDenoisedStream(raw, settings);
      micTestChain = chained.chain || null;
      metered = chained.stream;
      if (chained.degraded) vlog('mic test: suppression unavailable:', chained.reason);
    }

    micTestAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (micTestAudioCtx.state === 'suspended') {
      await micTestAudioCtx.resume();
    }
    const source = micTestAudioCtx.createMediaStreamSource(metered);
    micTestAnalyser = micTestAudioCtx.createAnalyser();
    micTestAnalyser.fftSize = 256;
    micTestAnalyser.smoothingTimeConstant = 0.35;
    source.connect(micTestAnalyser);

    const buf = new Uint8Array(micTestAnalyser.frequencyBinCount);
    isTestingMic = true;
    updateMicTestUI(true);

    const meter1 = document.getElementById('voice-modal-mic-meter');
    const meter2 = document.getElementById('settings-voice-mic-meter');

    function draw() {
      if (!isTestingMic || !micTestAnalyser) return;
      micTestAnimFrame = requestAnimationFrame(draw);
      micTestAnalyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const avg = sum / buf.length;
      const pct = Math.min(100, Math.round((avg / 50) * 100));
      if (meter1) meter1.style.width = pct + '%';
      if (meter2) meter2.style.width = pct + '%';
    }
    draw();
  } catch (err) {
    console.warn('startMicTest error:', err);
    stopMicTest();
  }
}

function stopMicTest() {
  isTestingMic = false;
  if (micTestAnimFrame) {
    cancelAnimationFrame(micTestAnimFrame);
    micTestAnimFrame = null;
  }
  if (micTestStream) {
    micTestStream.getTracks().forEach(t => t.stop());
    micTestStream = null;
  }
  if (micTestChain) {
    micTestChain.stop();
    micTestChain = null;
  }
  if (micTestAudioCtx) {
    micTestAudioCtx.close().catch(() => {});
    micTestAudioCtx = null;
  }
  micTestAnalyser = null;
  const meter1 = document.getElementById('voice-modal-mic-meter');
  const meter2 = document.getElementById('settings-voice-mic-meter');
  if (meter1) meter1.style.width = '0%';
  if (meter2) meter2.style.width = '0%';
  updateMicTestUI(false);
}

function updateMicTestUI(testing) {
  const btns = [
    document.getElementById('voice-modal-test-mic-btn'),
    document.getElementById('settings-voice-test-mic-btn')
  ];
  btns.forEach(btn => {
    if (!btn) return;
    if (testing) {
      btn.innerHTML = '<i class="ph-bold ph-stop"></i> <span>Stop Test</span>';
      btn.classList.add('active-testing');
    } else {
      btn.innerHTML = '<i class="ph-bold ph-waveform"></i> <span>Test Mic</span>';
      btn.classList.remove('active-testing');
    }
  });
}

async function testAudioOutput(outputDeviceId) {
  const targetDeviceId = (outputDeviceId !== undefined && outputDeviceId !== null) ? outputDeviceId : selectedAudioOutputId;
  const audio = new Audio(SOUNDS.joined || '/aud/joined.wav');
  audio.volume = DEFAULT_SFX_VOLUME;
  if (targetDeviceId && typeof audio.setSinkId === 'function') {
    try {
      await audio.setSinkId(targetDeviceId);
    } catch (e) {
      console.warn('setSinkId failed on test audio:', e);
    }
  }
  try {
    await audio.play();
  } catch (err) {
    // Web Audio synthesizer chime fallback
    try {
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      if (targetDeviceId && typeof actx.setSinkId === 'function') {
        await actx.setSinkId(targetDeviceId);
      }
      const osc = actx.createOscillator();
      const gain = actx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, actx.currentTime);
      osc.frequency.setValueAtTime(880, actx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.2, actx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(actx.destination);
      osc.start();
      osc.stop(actx.currentTime + 0.35);
      setTimeout(() => actx.close(), 500);
    } catch (e2) {
      console.warn('Chime oscillator fallback failed:', e2);
    }
  }
}

function initAudioDeviceListeners() {
  const voiceModalInput = document.getElementById('voice-modal-input-select');
  const settingsVoiceInput = document.getElementById('settings-voice-input-select');
  const voiceModalOutput = document.getElementById('voice-modal-output-select');
  const settingsVoiceOutput = document.getElementById('settings-voice-output-select');

  if (voiceModalInput) {
    voiceModalInput.addEventListener('change', (e) => changeAudioInputDevice(e.target.value));
  }
  if (settingsVoiceInput) {
    settingsVoiceInput.addEventListener('change', (e) => changeAudioInputDevice(e.target.value));
  }
  if (voiceModalOutput) {
    voiceModalOutput.addEventListener('change', (e) => changeAudioOutputDevice(e.target.value));
  }
  if (settingsVoiceOutput) {
    settingsVoiceOutput.addEventListener('change', (e) => changeAudioOutputDevice(e.target.value));
  }

  const voiceModalMicBtn = document.getElementById('voice-modal-test-mic-btn');
  const settingsVoiceMicBtn = document.getElementById('settings-voice-test-mic-btn');
  if (voiceModalMicBtn) {
    voiceModalMicBtn.addEventListener('click', () => isTestingMic ? stopMicTest() : startMicTest());
  }
  if (settingsVoiceMicBtn) {
    settingsVoiceMicBtn.addEventListener('click', () => isTestingMic ? stopMicTest() : startMicTest());
  }

  const voiceModalSpkBtn = document.getElementById('voice-modal-test-speaker-btn');
  const settingsVoiceSpkBtn = document.getElementById('settings-voice-test-speaker-btn');
  if (voiceModalSpkBtn) {
    voiceModalSpkBtn.addEventListener('click', () => testAudioOutput());
  }
  if (settingsVoiceSpkBtn) {
    settingsVoiceSpkBtn.addEventListener('click', () => testAudioOutput());
  }

  if (voiceSettingsBtn) {
    voiceSettingsBtn.addEventListener('click', openVoiceSettingsModal);
  }
  if (voiceStatusSettingsBtn) {
    voiceStatusSettingsBtn.addEventListener('click', openVoiceSettingsModal);
  }
  if (voiceSettingsCloseBtn) {
    voiceSettingsCloseBtn.addEventListener('click', closeVoiceSettingsModal);
  }

  initNoiseSuppressionUI();

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      populateAudioDevices(true).catch(() => {});
    });
  }

  // Prepopulate devices (auto-request in desktop app where webview auto-approves)
  const isDesktop = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  populateAudioDevices(isDesktop).catch(() => {});
}

// Initialize audio device listeners
initAudioDeviceListeners();

/* Typing Indicator */

let typingDebounceTimer = null;
const TYPING_INTERVAL = 2000;

messageInput.addEventListener('input', () => {
  autoResize();
  if (messageInput.value.trim()) {
    sendTypingStart();
  } else {
    sendTypingStop();
  }
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    sendTypingStop();
  }
});

function sendTypingStart() {
  if (!currentChannelId) return;
  const now = Date.now();
  if (typingDebounceTimer && now - typingDebounceTimer < TYPING_INTERVAL) return;
  typingDebounceTimer = now;
  sendWS('typing:start', { channelId: currentChannelId });
}

function sendTypingStop() {
  if (!currentChannelId) return;
  typingDebounceTimer = null;
  sendWS('typing:stop', { channelId: currentChannelId });
}

function handleTypingStart(data) {
  if (data.channelId !== currentChannelId || data.userId === currentUser.id) return;
  if (!typingUsers[currentChannelId]) typingUsers[currentChannelId] = {};
  if (typingUsers[currentChannelId][data.userId]) {
    clearTimeout(typingUsers[currentChannelId][data.userId].timeout);
  }
  typingUsers[currentChannelId][data.userId] = {
    username: data.username,
    timeout: setTimeout(() => removeTyper(data.channelId, data.userId), 3000)
  };
  updateTypingIndicator();
}

function handleTypingStop(data) {
  removeTyper(data.channelId, data.userId);
}

function removeTyper(channelId, userId) {
  if (!typingUsers[channelId] || !typingUsers[channelId][userId]) return;
  clearTimeout(typingUsers[channelId][userId].timeout);
  delete typingUsers[channelId][userId];
  updateTypingIndicator();
}

function updateTypingIndicator() {
  if (!currentChannelId || !typingUsers[currentChannelId]) {
    typingIndicator.style.display = 'none';
    return;
  }
  const typers = Object.values(typingUsers[currentChannelId]);
  if (typers.length === 0) {
    typingIndicator.style.display = 'none';
    return;
  }
  typingIndicator.style.display = 'flex';
  const names = typers.map(t => t.username);
  if (names.length === 1) {
    typingText.textContent = `${names[0]} is typing`;
  } else if (names.length === 2) {
    typingText.textContent = `${names[0]} and ${names[1]} are typing`;
  } else {
    typingText.textContent = `${names[0]} and ${names.length - 1} others are typing`;
  }
}

/* ── Pinned Messages Drawer ─────────────────────────────────────────── */

function updatePinnedBadge() {
  if (!pinnedCountBadge) return;
  const ch = (channels || []).find(c => c.id === currentChannelId);
  const count = (ch && ch.pinned) ? ch.pinned.length : 0;
  if (count > 0) {
    pinnedCountBadge.style.display = 'inline-block';
    pinnedCountBadge.textContent = count > 99 ? '99+' : String(count);
  } else {
    pinnedCountBadge.style.display = 'none';
    pinnedCountBadge.textContent = '0';
  }
}

function openPinnedDrawer() {
  if (!pinnedDrawer) return;
  pinnedDrawer.style.display = 'flex';
  renderPinnedMessages();
}

function closePinnedDrawer() {
  if (!pinnedDrawer) return;
  pinnedDrawer.style.display = 'none';
}

function togglePinMessage(messageId) {
  if (!currentChannelId) return;
  const ch = channels.find(c => c.id === currentChannelId);
  if (!ch) return;
  const pinnedList = ch.pinned || [];
  const isPinned = pinnedList.find(p => p.messageId === messageId);
  if (isPinned) {
    sendWS('message:unpin', { channelId: currentChannelId, messageId });
  } else {
    sendWS('message:pin', { channelId: currentChannelId, messageId });
  }
}

function handleMessagePin(data) {
  const ch = channels.find(c => c.id === data.channelId);
  if (ch) {
    if (!ch.pinned) ch.pinned = [];
    if (!ch.pinned.find(p => p.messageId === data.messageId)) {
      ch.pinned.push({ messageId: data.messageId, text: data.text, pinnedBy: data.pinnedBy, pinnedAt: data.pinnedAt });
    }
  }
  if (data.channelId === currentChannelId) {
    updatePinnedBadge();
    if (pinnedDrawer && pinnedDrawer.style.display === 'flex') {
      renderPinnedMessages();
    }
    const pinBtn = document.querySelector(`#msg-${data.messageId} .pin-btn`);
    if (pinBtn) {
      pinBtn.classList.add('pinned');
      pinBtn.title = 'Unpin message';
    }
  }
}

function handleMessageUnpin(data) {
  const ch = channels.find(c => c.id === data.channelId);
  if (ch && ch.pinned) {
    ch.pinned = ch.pinned.filter(p => p.messageId !== data.messageId);
  }
  if (data.channelId === currentChannelId) {
    updatePinnedBadge();
    if (pinnedDrawer && pinnedDrawer.style.display === 'flex') {
      renderPinnedMessages();
    }
    const pinBtn = document.querySelector(`#msg-${data.messageId} .pin-btn`);
    if (pinBtn) {
      pinBtn.classList.remove('pinned');
      pinBtn.title = 'Pin message';
    }
  }
}

async function renderPinnedMessages() {
  updatePinnedBadge();
  if (!pinnedMessagesList) return;
  if (!currentChannelId) {
    pinnedMessagesList.innerHTML = '<div class="pinned-empty">Select a channel to view pinned messages</div>';
    return;
  }

  try {
    const authToken = token || localStorage.getItem('token');
    const res = await fetch(`/api/channels/${currentChannelId}/pins`, {
      headers: authToken ? { Authorization: authToken } : {}
    });
    if (!res.ok) {
      pinnedMessagesList.innerHTML = '<div class="pinned-empty">Could not load pinned messages</div>';
      return;
    }
    const data = await res.json();
    const pins = data.pins || [];

    // Keep channel.pinned synchronized if channel object exists
    const ch = (channels || []).find(c => c.id === currentChannelId);
    if (ch) {
      ch.pinned = pins.map(p => ({
        messageId: p.id,
        text: p.text,
        pinnedBy: p.pinnedBy,
        pinnedAt: p.pinnedAt
      }));
      updatePinnedBadge();
    }

    if (pins.length === 0) {
      pinnedMessagesList.innerHTML = `
        <div class="pinned-empty">
          <i class="ph-bold ph-push-pin" style="font-size: 26px; display: block; margin-bottom: 8px; opacity: 0.5;"></i>
          No pinned messages in this channel
        </div>
      `;
      return;
    }

    pinnedMessagesList.innerHTML = '';
    pins.forEach(pin => {
      const card = document.createElement('div');
      card.className = 'pinned-message-card';

      const avatarSrc = getUserAvatarUrl({ profilePic: pin.profilePic, username: pin.username });
      const timeStr = pin.timestamp ? formatTime(pin.timestamp) : '';
      const canUnpin = currentUser && (isAdmin(currentUser.role) || currentUser.username === pin.pinnedBy);

      let fileHtml = '';
      if (pin.files && pin.files.length > 0) {
        fileHtml = `<div class="pinned-card-files" style="font-size:11px;color:var(--accent);margin-top:4px;"><i class="ph ph-paperclip"></i> ${pin.files.length} attachment${pin.files.length > 1 ? 's' : ''}</div>`;
      }

      card.innerHTML = `
        <div class="pinned-card-header">
          <div class="pinned-card-user">
            <div class="pinned-card-avatar"><img src="${avatarSrc}" alt="${escapeHtml(pin.username)}"></div>
            <span class="pinned-card-name">${escapeHtml(pin.username)}</span>
            <span class="pinned-card-time">${timeStr}</span>
          </div>
        </div>
        <div class="pinned-card-body">${pin.text ? renderMessageContent(pin.text) : ''}${fileHtml}</div>
        <div class="pinned-card-footer">
          <span class="pinned-card-meta">Pinned by ${escapeHtml(pin.pinnedBy || 'admin')}</span>
          <div class="pinned-card-actions">
            <button class="pinned-btn-jump" title="Jump to message">Jump</button>
            ${canUnpin ? `<button class="pinned-btn-unpin" title="Unpin message">Unpin</button>` : ''}
          </div>
        </div>
      `;

      const jumpBtn = card.querySelector('.pinned-btn-jump');
      if (jumpBtn) {
        jumpBtn.addEventListener('click', () => {
          jumpToMessage(pin.channelId, pin.id);
        });
      }

      const unpinBtn = card.querySelector('.pinned-btn-unpin');
      if (unpinBtn) {
        unpinBtn.addEventListener('click', () => {
          togglePinMessage(pin.id);
        });
      }

      pinnedMessagesList.appendChild(card);
    });
  } catch (err) {
    console.error('Error fetching pinned messages:', err);
    pinnedMessagesList.innerHTML = '<div class="pinned-empty">Failed to load pinned messages</div>';
  }
}

/* ── Message Search (Ctrl+F) ────────────────────────────────────────── */

function openSearchModal() {
  if (!currentUser) return;
  if (searchModal) searchModal.style.display = 'flex';
  if (searchInput) {
    searchInput.focus();
    if (searchInput.value.trim()) {
      executeSearch(searchInput.value);
    } else {
      if (searchResults) {
        searchResults.innerHTML = '<div class="pinned-empty">Type a search query or use filters like from:username or has:file</div>';
      }
    }
  }
}

function closeSearchModal() {
  if (!searchModal) return;
  searchModal.style.display = 'none';
  if (messageInput) messageInput.focus();
}

async function executeSearch(query) {
  if (!searchResults) return;
  const raw = (query || '').trim();
  if (!raw) {
    searchResults.innerHTML = '<div class="pinned-empty">Type a search query or use filters like from:username or has:file</div>';
    return;
  }

  // Parse filters: from:user, has:file|image|url
  let cleanQuery = raw;
  let fromUser = '';
  let hasFilter = '';

  const fromMatch = cleanQuery.match(/\bfrom:(\S+)/i);
  if (fromMatch) {
    fromUser = fromMatch[1];
    cleanQuery = cleanQuery.replace(fromMatch[0], '');
  }

  const hasMatch = cleanQuery.match(/\bhas:(\S+)/i);
  if (hasMatch) {
    hasFilter = hasMatch[1];
    cleanQuery = cleanQuery.replace(hasMatch[0], '');
  }

  cleanQuery = cleanQuery.replace(/\s+/g, ' ').trim();

  const params = new URLSearchParams();
  if (cleanQuery) params.set('q', cleanQuery);
  if (fromUser) params.set('from', fromUser);
  if (hasFilter) params.set('has', hasFilter);
  if (currentSearchScope === 'channel' && currentChannelId) {
    params.set('channelId', currentChannelId);
  }

  searchResults.innerHTML = '<div class="pinned-empty"><i class="ph ph-spinner-gap" style="animation: spin 1s linear infinite; display: inline-block;"></i> Searching...</div>';

  try {
    const authToken = token || localStorage.getItem('token');
    const res = await fetch(`/api/search?${params.toString()}`, {
      headers: authToken ? { Authorization: authToken } : {}
    });
    if (!res.ok) {
      searchResults.innerHTML = '<div class="pinned-empty">Error performing search</div>';
      return;
    }
    const data = await res.json();
    renderSearchResults(data.results || [], cleanQuery);
  } catch (err) {
    console.error('Search request failed:', err);
    searchResults.innerHTML = '<div class="pinned-empty">Search request failed</div>';
  }
}

function renderSearchResults(results, query) {
  if (!searchResults) return;
  searchResults.innerHTML = '';

  if (!results || results.length === 0) {
    searchResults.innerHTML = '<div class="pinned-empty">No messages found matching your query</div>';
    return;
  }

  const queryTerms = (query || '').trim().split(/\s+/).filter(Boolean);

  function highlightMatches(text) {
    if (!text) return '';
    let escaped = escapeHtml(text);
    if (queryTerms.length === 0) return escaped;
    queryTerms.forEach(term => {
      if (term.length > 0) {
        const regex = new RegExp(`(${escapeRegex(escapeHtml(term))})`, 'gi');
        escaped = escaped.replace(regex, '<mark>$1</mark>');
      }
    });
    return escaped;
  }

  results.forEach(item => {
    const el = document.createElement('div');
    el.className = 'search-result-item';

    const avatarSrc = getUserAvatarUrl({ profilePic: item.profilePic, username: item.username });
    const timeStr = item.timestamp ? formatTime(item.timestamp) : '';
    const highlightedText = highlightMatches(item.text);

    let attachmentsHtml = '';
    if (item.files && item.files.length > 0) {
      attachmentsHtml = `<div class="search-result-files" style="font-size:11px;color:var(--accent);margin-top:4px;"><i class="ph ph-paperclip"></i> ${item.files.length} attachment${item.files.length > 1 ? 's' : ''}</div>`;
    }

    el.innerHTML = `
      <div class="search-result-header">
        <div class="search-result-user">
          <div class="search-result-avatar"><img src="${avatarSrc}" alt="${escapeHtml(item.username)}"></div>
          <span class="search-result-username">${escapeHtml(item.username)}</span>
          <span class="search-result-channel">${escapeHtml(item.channelName || 'channel')}</span>
        </div>
        <span class="search-result-time">${timeStr}</span>
      </div>
      <div class="search-result-text">${highlightedText || ''}${attachmentsHtml}</div>
      <div class="search-result-jump"><i class="ph-bold ph-arrow-right"></i> Jump</div>
    `;

    el.addEventListener('click', () => {
      jumpToMessage(item.channelId, item.id);
    });

    searchResults.appendChild(el);
  });
}

if (searchBtn) {
  searchBtn.addEventListener('click', openSearchModal);
}

if (searchModalClose) {
  searchModalClose.addEventListener('click', closeSearchModal);
}

if (searchModal) {
  searchModal.addEventListener('click', (e) => {
    if (e.target === searchModal) closeSearchModal();
  });
}

if (searchScopeChannel) {
  searchScopeChannel.addEventListener('click', () => {
    currentSearchScope = 'channel';
    searchScopeChannel.classList.add('active');
    if (searchScopeAll) searchScopeAll.classList.remove('active');
    if (searchInput && searchInput.value.trim()) executeSearch(searchInput.value);
  });
}

if (searchScopeAll) {
  searchScopeAll.addEventListener('click', () => {
    currentSearchScope = 'all';
    searchScopeAll.classList.add('active');
    if (searchScopeChannel) searchScopeChannel.classList.remove('active');
    if (searchInput && searchInput.value.trim()) executeSearch(searchInput.value);
  });
}

if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      executeSearch(e.target.value);
    }, 250);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchDebounceTimer);
      executeSearch(e.target.value);
    }
  });
}

if (pinnedBtn) {
  pinnedBtn.addEventListener('click', () => {
    if (pinnedDrawer && pinnedDrawer.style.display === 'flex') {
      closePinnedDrawer();
    } else {
      openPinnedDrawer();
    }
  });
}

if (pinnedDrawerClose) {
  pinnedDrawerClose.addEventListener('click', closePinnedDrawer);
}

/* ── Reactions ──────────────────────────────────────────────────────────── */

function renderReactions(container, messageId, reactions) {
  container.innerHTML = '';
  if (!reactions || Object.keys(reactions).length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  Object.entries(reactions).forEach(([emoji, userIds]) => {
    const btn = document.createElement('button');
    const isActive = userIds.includes(currentUser.id);
    btn.className = 'reaction-badge' + (isActive ? ' active' : '');
    btn.innerHTML = `${emoji} <span class="reaction-count">${userIds.length}</span>`;
    btn.addEventListener('click', () => toggleReaction(messageId, emoji));
    container.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'reaction-badge reaction-add';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', (e) => showReactionPicker(e, messageId));
  container.appendChild(addBtn);
}

let currentReactionMessageId = null;

function showReactionPicker(e, messageId) {
  e.stopPropagation();
  currentReactionMessageId = messageId;
  reactionPicker.style.display = 'flex';
  // Use clientX/Y if available (context menu), else use target bounding rect
  const x = e.clientX != null ? e.clientX : (e.target ? e.target.getBoundingClientRect().left : 0);
  const y = e.clientY != null ? e.clientY : (e.target ? e.target.getBoundingClientRect().top : 0);
  reactionPicker.style.left = Math.min(x, window.innerWidth - 340) + 'px';
  reactionPicker.style.top = Math.max(y - 420, 10) + 'px';
}

document.querySelectorAll('.quick-reaction-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const emoji = btn.dataset.emoji;
    if (currentReactionMessageId && emoji) {
      toggleReaction(currentReactionMessageId, emoji);
    }
    reactionPicker.style.display = 'none';
    currentReactionMessageId = null;
  });
});

reactionEmojiPicker.addEventListener('emoji-click', (e) => {
  e.stopPropagation();
  if (currentReactionMessageId) {
    toggleReaction(currentReactionMessageId, e.detail.unicode);
    reactionPicker.style.display = 'none';
    currentReactionMessageId = null;
  }
});

function toggleReaction(messageId, emoji) {
  if (!currentChannelId) return;
  sendWS('message:react', { channelId: currentChannelId, messageId, emoji });
}

document.addEventListener('click', () => {
  reactionPicker.style.display = 'none';
});

reactionPicker.addEventListener('click', (e) => e.stopPropagation());

/* ── Emoji Picker ───────────────────────────────────────────────────────── */

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = emojiPickerContainer.style.display === 'block';
  emojiPickerContainer.style.display = isOpen ? 'none' : 'block';
});

emojiPicker.addEventListener('emoji-click', (e) => {
  const emoji = e.detail.unicode;
  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  messageInput.value = messageInput.value.substring(0, start) + emoji + messageInput.value.substring(end);
  messageInput.selectionStart = messageInput.selectionEnd = start + emoji.length;
  messageInput.focus();
  emojiPickerContainer.style.display = 'none';
});

document.addEventListener('click', (e) => {
  if (!emojiPickerContainer.contains(e.target) && e.target !== emojiBtn) {
    emojiPickerContainer.style.display = 'none';
  }
});

emojiPickerContainer.addEventListener('click', (e) => e.stopPropagation());

/* ── Floating Screen Share (PiP) ──────────────────────────────────────── */

const PIP_EDGE_MARGIN = 16;
const PIP_SNAP_DISTANCE = 60;
const PIP_CLICK_THRESHOLD = 5;
let pipPosition = null; // { x, y } viewport left/top once user dragged it

document.querySelectorAll('.livestream-mute-btn').forEach(btn => {
  btn.addEventListener('click', toggleLivestreamMute);
});

function hasAnyScreenShare() {
  return [...voiceScreenContainer.querySelectorAll('video')].some(v => v.style.display !== 'none');
}

function clampPiPPosition(x, y) {
  const w = floatingScreenShare.offsetWidth || 320;
  const h = floatingScreenShare.offsetHeight || 213;
  return {
    x: Math.min(Math.max(x, 8), window.innerWidth - w - 8),
    y: Math.min(Math.max(y, 8), window.innerHeight - h - 8)
  };
}

function setPiPPosition(x, y) {
  const pos = clampPiPPosition(x, y);
  pipPosition = pos;
  floatingScreenShare.style.left = `${pos.x}px`;
  floatingScreenShare.style.top = `${pos.y}px`;
  floatingScreenShare.style.right = 'auto';
  floatingScreenShare.style.bottom = 'auto';
}

function positionPiPDefault() {
  if (pipPosition) {
    setPiPPosition(pipPosition.x, pipPosition.y);
    return;
  }
  const w = floatingScreenShare.offsetWidth || 320;
  const h = floatingScreenShare.offsetHeight || 213;
  setPiPPosition(window.innerWidth - w - 20, window.innerHeight - h - 80);
}

function showFloatingScreenShare() {
  if (pipDismissed) return;
  const videos = [...voiceScreenContainer.querySelectorAll('video')].filter(v => v.style.display !== 'none');
  if (videos.length === 0) return;
  floatingScreenContainer.innerHTML = '';
  videos.forEach(v => {
    const clone = document.createElement('video');
    clone.srcObject = v.srcObject;
    clone.autoplay = true;
    clone.muted = true;
    clone.playsInline = true;
    clone.className = 'voice-screen-video';
    clone.dataset.screenUser = v.dataset.screenUser || '';
    floatingScreenContainer.appendChild(clone);
    clone.play().catch(() => {});
  });
  floatingScreenShare.style.display = 'flex';
  positionPiPDefault();
  floatingScreenLabel.textContent = voiceScreenSharing
    ? 'Your Screen'
    : (voiceScreenLabel.textContent || 'Screen Share');
}

function hideFloatingScreenShare() {
  floatingScreenShare.style.display = 'none';
  floatingScreenContainer.innerHTML = '';
}

function syncPiP() {
  if (floatingScreenShare.style.display !== 'flex') return;
  if (voiceScreenSharing || hasAnyScreenShare()) {
    showFloatingScreenShare();
  } else {
    hideFloatingScreenShare();
  }
}

function returnToCallFromPiP() {
  hideFloatingScreenShare();
  if (voiceJoined && voiceChannelId) {
    switchChannel(voiceChannelId);
  }
}

function snapPiPToEdge() {
  if (!pipPosition) return;
  const rect = floatingScreenShare.getBoundingClientRect();
  if (rect.left <= PIP_SNAP_DISTANCE) {
    setPiPPosition(PIP_EDGE_MARGIN, pipPosition.y);
  } else if (window.innerWidth - rect.right <= PIP_SNAP_DISTANCE) {
    setPiPPosition(window.innerWidth - rect.width - PIP_EDGE_MARGIN, pipPosition.y);
  }
}

floatingScreenShare.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('button')) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const rect = floatingScreenShare.getBoundingClientRect();
  const offsetX = startX - rect.left;
  const offsetY = startY - rect.top;
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.max(Math.abs(ev.clientX - startX), Math.abs(ev.clientY - startY)) < PIP_CLICK_THRESHOLD) return;
    moved = true;
    setPiPPosition(ev.clientX - offsetX, ev.clientY - offsetY);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (moved) {
      snapPiPToEdge();
    } else {
      returnToCallFromPiP();
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

window.addEventListener('resize', () => {
  if (floatingScreenShare.style.display === 'flex') positionPiPDefault();
});

floatingScreenCloseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (voiceScreenSharing) {
    pipDismissed = true;
    hideFloatingScreenShare();
    return;
  }
  const watched = focusedScreenUserId;
  hideFloatingScreenShare();
  if (watched != null) stopViewingScreen(watched);
});

/* ── Init ──────────────────────────────────────────────────────────────── */

async function init() {
  if (token) {
    try {
      const res = await fetch('/api/me', { headers: { Authorization: token } });
      if (res.ok) {
        const data = await res.json();
        currentUser = data.user;
        showApp();
        connectWS();

        // Auto-login: no login button click happened, so unlock audio on first user gesture
        const unlockAudio = async () => {
          await initSounds();
          // Remove these specific listeners, keep the general ones
          document.removeEventListener('click', unlockAudio);
          document.removeEventListener('keydown', unlockAudio);
        };
        document.addEventListener('click', unlockAudio, { once: true });
        document.addEventListener('keydown', unlockAudio, { once: true });

        // Also set up persistent sound initialization triggers
        document.addEventListener('click', triggerSoundInit);
        document.addEventListener('keydown', triggerSoundInit);

        return;
      }
    } catch (e) {
      console.warn('Auto-login failed:', e);
    }
  }
  localStorage.removeItem('token');
  showAuth();
}

/* ── Exports & Init Execution Guard ────────────────────────────────────── */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    showConfirmModal,
    showAlertModal,
    showPromptModal,
    archiveDmConversation,
    unarchiveDmConversation,
    deleteDmConversation,
    getSortedDmChannels,
    loadArchivedDms,
    saveArchivedDms,
    getArchivedDmIds: () => archivedDmIds,
    setArchivedDmIds: (ids) => { archivedDmIds = ids; },
    setChannels: (chList) => { channels = chList; },
    setCurrentUser: (u) => { currentUser = u; },
    setCurrentChannelId: (id) => { currentChannelId = id; },
    getCurrentChannelId: () => currentChannelId,
    setSendWS: (fn) => { customSendWSHook = fn; }
  };
}

if (typeof window !== 'undefined' && !(typeof process !== 'undefined' && process.versions && process.versions.node)) {
  init();
}