console.log('main.js v6.7 - FIXED MULTI-PEER');

// ─── Estado global ─────────────────────────────────────────────────────────────
var mapPeers = {};
var username;
var webSocket;
var localStream = new MediaStream();
var isScreenSharing = false;
var screenStream = null;
var isVideoOn = false;
var isAudioOn = false;
var originalCamStream = null;
var originalMicStream = null;
var isAnyScreenSharing = false;
var isRoomAdmin = false;
var roomCode = "";
var isProcessingApproval = false;
var isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
var activeReactions = {};
var wsReconnectTimer = null;
var appIsBackground = false;
var btnSendMsg, messageList, messageInput, selectTargetUser;
var reconnectAttempts = 0;
var maxReconnectAttempts = 5;
var isReconnecting = false;
var heartbeatInterval = null;
var myChannelName = null;
var screenSharerUsername = null;
var screenShareOfferSent = {};

// ─── ICE ───────────────────────────────────────────────────────────────────────
const iceConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all'
};

// ─── DETECCIÓN DE BACKGROUND ──────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        appIsBackground = true;
        startHeartbeat(10000);
    } else {
        appIsBackground = false;
        stopHeartbeat();
        setTimeout(() => {
            console.log('[App] Volviendo al foco, verificando conexión...');
            checkAndReconnect();
        }, 800);
    }
});

document.addEventListener('pagehide', () => {
    appIsBackground = true;
});

// ─── HEARTBEAT ─────────────────────────────────────────────────────────────────
function startHeartbeat(interval = 5000) {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (webSocket && webSocket.readyState === WebSocket.OPEN) {
            try {
                webSocket.send(JSON.stringify({
                    peer: username,
                    action: 'ping',
                    room_code: roomCode,
                    message: {}
                }));
            } catch(e) {
                console.warn('[Heartbeat] Error:', e);
                checkAndReconnect();
            }
        } else {
            checkAndReconnect();
        }
    }, interval);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// ─── RECONEXIÓN ─────────────────────────────────────────────────────────────────
function checkAndReconnect() {
    if (!username || !roomCode) return;
    if (isReconnecting) return;

    var wsOk = webSocket && webSocket.readyState === WebSocket.OPEN;
    var hasPeers = Object.keys(mapPeers).length > 0;
    var peersConnected = false;

    if (hasPeers) {
        peersConnected = Object.values(mapPeers).some(p => {
            var peer = p[0];
            if (!peer) return false;
            var state = peer.connectionState || peer.iceConnectionState;
            return state === 'connected' || state === 'connecting';
        });
    }

    console.log('[Reconexión] WS:', wsOk ? 'OK' : 'CAÍDO', '| Peers:', peersConnected ? 'Conectados' : 'Sin conexión');

    if (!wsOk) {
        console.log('[Reconexión] WebSocket caído');
        showReconnectBanner('🔌 Reconectando...');
        isReconnecting = true;
        reconnectWebSocket();
        return;
    }

    if (hasPeers && !peersConnected) {
        console.log('[Reconexión] Peers desconectados');
        showReconnectBanner('🔄 Recuperando video...');
        isReconnecting = true;
        renegotiateAllPeers();
        return;
    }

    if (wsOk && (!hasPeers || peersConnected)) {
        hideReconnectBanner();
        isReconnecting = false;
        reconnectAttempts = 0;
    }
}

function reconnectWebSocket() {
    if (webSocket) {
        try {
            webSocket.onclose = null;
            webSocket.close();
        } catch(e) {}
        webSocket = null;
    }

    if (isScreenSharing) stopScreenShare();
    isAnyScreenSharing = false;
    screenSharerUsername = null;
    screenShareOfferSent = {};
    updateShareScreenBtn();

    Object.keys(mapPeers).forEach(p => {
        try { if (mapPeers[p][0]) { mapPeers[p][0].oniceconnectionstatechange = null; mapPeers[p][0].close(); } } catch(e) {}
        try { if (mapPeers[p][2]) { mapPeers[p][2].oniceconnectionstatechange = null; mapPeers[p][2].close(); } } catch(e) {}
        var videoEl = document.getElementById(p + '-video');
        if (videoEl) { videoEl.style.filter = 'brightness(0.3)'; videoEl.style.opacity = '0.5'; }
        delete mapPeers[p];
    });

    var loc = window.location;
    var wsUrl = (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws/' + roomCode + '/';
    console.log('[Reconexión] Conectando a:', wsUrl);

    webSocket = new WebSocket(wsUrl);

    webSocket.addEventListener('open', () => {
        console.log('[Reconexión] ✅ WebSocket reconectado a sala:', roomCode);
        isReconnecting = false;
        reconnectAttempts = 0;
        sendSignal('join-room-group', {});
        setTimeout(() => {
            sendSignal('new-peer', {});
            hideReconnectBanner();
            restoreLocalVideo();
            resendAllActiveReactions();
        }, 1000);
    });

    webSocket.addEventListener('message', webSocketOnMessage);

    webSocket.addEventListener('close', (e) => {
        console.warn('[WS] Cerrado:', e.code, e.reason);
        if (!appIsBackground && !isReconnecting) {
            reconnectAttempts++;
            if (reconnectAttempts < maxReconnectAttempts) {
                if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
                wsReconnectTimer = setTimeout(checkAndReconnect, 3000 * reconnectAttempts);
            } else {
                showReconnectBanner('⚠️ Problemas de conexión, recargando...');
                setTimeout(() => window.location.reload(), 3000);
            }
        }
    });

    webSocket.addEventListener('error', e => {
        console.error('[WS] Error:', e);
        if (!isReconnecting) checkAndReconnect();
    });
}

function renegotiateAllPeers() {
    var peersToRenegotiate = Object.keys(mapPeers);
    if (peersToRenegotiate.length === 0) {
        isReconnecting = false;
        hideReconnectBanner();
        return;
    }

    peersToRenegotiate.forEach(peerUsername => {
        var peer = mapPeers[peerUsername] ? mapPeers[peerUsername][0] : null;
        if (!peer) {
            createOfferer(peerUsername, mapPeers[peerUsername] ? mapPeers[peerUsername][3] : null);
            return;
        }
        var state = peer.connectionState || peer.iceConnectionState;
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
            console.log('[Reconexión] Renegociando con', peerUsername);
            try { peer.oniceconnectionstatechange = null; peer.close(); } catch(e) {}
            var slot = document.getElementById(peerUsername + '-slot');
            if (slot && slot.parentNode) slot.parentNode.removeChild(slot);
            var savedChannel = mapPeers[peerUsername] ? mapPeers[peerUsername][3] : null;
            delete mapPeers[peerUsername];
            createOfferer(peerUsername, savedChannel);
        }
    });

    setTimeout(() => {
        var hasConnected = Object.values(mapPeers).some(p => {
            var peer = p[0];
            return peer && (peer.connectionState === 'connected' || peer.iceConnectionState === 'connected');
        });
        if (hasConnected) {
            hideReconnectBanner();
            isReconnecting = false;
        } else {
            setTimeout(checkAndReconnect, 2000);
        }
    }, 3000);
}

function restoreLocalVideo() {
    var localVideoEl = document.querySelector('#local-video');
    if (localVideoEl && localStream) {
        localVideoEl.srcObject = localStream;
        localVideoEl.play().catch(() => {});
    }
}

function showReconnectBanner(msg) {
    var banner = document.getElementById('reconnect-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'reconnect-banner';
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0',
            'background:linear-gradient(135deg,#e67e22,#f39c12)',
            'color:#fff', 'text-align:center', 'padding:12px',
            'z-index:99999', 'font-size:0.9rem', 'font-weight:bold',
            'display:flex', 'align-items:center', 'justify-content:center',
            'gap:8px', 'box-shadow:0 2px 10px rgba(0,0,0,0.3)'
        ].join(';');
        document.body.appendChild(banner);
    }
    banner.innerHTML = '<span style="animation:spin 1s linear infinite;display:inline-block">⟳</span> ' + msg;
    if (!document.getElementById('spin-style')) {
        var s = document.createElement('style');
        s.id = 'spin-style';
        s.textContent = '@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
        document.head.appendChild(s);
    }
}

function hideReconnectBanner() {
    var banner = document.getElementById('reconnect-banner');
    if (banner) banner.remove();
}

// ─── VERIFICAR ESTADO DE SCREEN SHARING ──────────────────────────────────────
function checkScreenSharingStatus() {
    var anyScreenActive = false;
    var sharer = null;

    for (var p in mapPeers) {
        if (mapPeers[p] && mapPeers[p][2]) {
            var screenPeer = mapPeers[p][2];
            var state = screenPeer.connectionState || screenPeer.iceConnectionState;
            if (state === 'connected' || state === 'connecting') {
                anyScreenActive = true;
                sharer = p;
                break;
            }
        }
    }

    if (anyScreenActive && sharer) {
        screenSharerUsername = sharer;
        isAnyScreenSharing = true;
        updateShareScreenBtn();
    } else if (!anyScreenActive && isAnyScreenSharing) {
        console.log('[Screen] Detectado estado inconsistente, liberando pantalla');
        isAnyScreenSharing = false;
        screenSharerUsername = null;
        screenShareOfferSent = {};
        updateShareScreenBtn();
        sendSignal('global-screen-released', {});
    }

    return anyScreenActive;
}

// ─── FUNCIÓN PARA ENVIAR SCREEN SHARE ──────────────────────────────────────────
function sendScreenShareToNewPeer(peerUsername) {
    if (!isScreenSharing || !screenStream) return;
    if (screenShareOfferSent[peerUsername]) return;

    var target_channel_name = mapPeers[peerUsername] ? mapPeers[peerUsername][3] : null;
    if (!target_channel_name) {
        console.warn('[Screen] No hay channel_name para', peerUsername);
        return;
    }

    console.log('[Screen] Enviando screen share a nuevo peer:', peerUsername);
    screenShareOfferSent[peerUsername] = true;
    createScreenOfferer(peerUsername, target_channel_name);
}

// ─── WebSocket onMessage ──────────────────────────────────────────────────────
function webSocketOnMessage(event) {
    try {
        var parsedData = JSON.parse(event.data);
        var peerUsername = parsedData['peer'];
        var action = parsedData['action'];
        var remoteRoomCode = parsedData['room_code'];

        if (username == peerUsername) return;

        var messagePayload = parsedData['message'] || {};
        var sender_channel_name = parsedData['sender_channel_name'] || messagePayload['sender_channel_name'] || null;

        // Guardar nuestro propio channel_name cuando llega en cualquier mensaje
        if (sender_channel_name && !myChannelName) {
            myChannelName = sender_channel_name;
            console.log('[WS] Mi channel_name:', myChannelName);
        }

        if (action == 'ping' || action == 'pong') {
            if (action == 'ping') {
                webSocket.send(JSON.stringify({
                    peer: username,
                    action: 'pong',
                    room_code: roomCode,
                    message: {}
                }));
            }
            return;
        }

        if (isRoomAdmin && action == 'request-access') {
            if (remoteRoomCode && remoteRoomCode === roomCode) {
                console.log('[Admin] Solicitud de acceso de:', peerUsername, 'canal:', sender_channel_name);
                showAccessRequest(peerUsername, sender_channel_name);
            }
            return;
        }

        if (!isRoomAdmin && action == 'access-response') {
            var status = parsedData['status'] || messagePayload['status'] || null;
            console.log('[User] Respuesta de acceso:', status);
            if (status == 'approved') {
                showConferenceUI();
                var finalRoomCode = parsedData['room_code'] || messagePayload['room_code'] || null;
                if (finalRoomCode) {
                    roomCode = finalRoomCode;
                    var el = document.getElementById('active-room-code');
                    if (el) el.innerText = roomCode;
                }
                initializeMediaAfterApproval();
                bindChatElements();
                injectReactionPanel();
                sendSignal('join-room-group', {});
                setTimeout(() => sendSignal('new-peer', {}), 500);
            } else {
                alert('❌ Tu solicitud de ingreso fue rechazada.');
                window.location.reload();
            }
            return;
        }

        if (action == 'global-screen-occupied') {
            isAnyScreenSharing = true;
            screenSharerUsername = peerUsername;
            updateShareScreenBtn();
            if (!isScreenSharing && peerUsername !== username) {
                setTimeout(() => {
                    if (mapPeers[peerUsername]) {
                        sendSignal('request-screen-sdp', {
                            target_channel_name: mapPeers[peerUsername][3]
                        });
                    }
                }, 2000);
            }
            return;
        }

        if (action == 'global-screen-released') {
            isAnyScreenSharing = false;
            screenSharerUsername = null;
            screenShareOfferSent = {};
            updateShareScreenBtn();
            if (peerUsername) removeVideo(document.getElementById(peerUsername + '-screen-video'));
            return;
        }

        // ─── NUEVO PEER ──────────────────────────────────────────────────────
        if (action == 'new-peer') {
            console.log('[WS] Nuevo peer:', peerUsername, 'canal:', sender_channel_name);

            // ✅ FIX: solo actualiza channel_name si viene uno válido, nunca sobreescribas con null
            if (!mapPeers[peerUsername]) {
                mapPeers[peerUsername] = [null, null, null, sender_channel_name];
            } else if (sender_channel_name) {
                mapPeers[peerUsername][3] = sender_channel_name;
            }

            var channelToUse = sender_channel_name || (mapPeers[peerUsername] ? mapPeers[peerUsername][3] : null);

            setTimeout(() => {
                createOfferer(peerUsername, channelToUse);
            }, 500);

            if (isScreenSharing && screenStream) {
                setTimeout(() => {
                    sendScreenShareToNewPeer(peerUsername);
                }, 2000);
            }

            // ✅ FIX: ELIMINADO el loop que intentaba reconectar peers entre sí.
            // Cada peer gestiona sus propias conexiones directamente.

            return;
        }

        if (action == 'new-offer') {
            var offerSdp = messagePayload['sdp'] || parsedData['sdp'];
            var isScreen = messagePayload['isScreen'] || parsedData['isScreen'] || false;

            console.log('[WS] Nueva oferta de:', peerUsername, 'screen:', isScreen);

            if (isScreen) {
                var sv = createVideo(peerUsername + '-screen', peerUsername + ' (Pantalla)');
                createScreenAnswerer(offerSdp, peerUsername, sender_channel_name, sv);
            } else {
                var pd = mapPeers[peerUsername];
                if (pd && pd[0]) {
                    var peerState = pd[0].signalingState;
                    // ✅ FIX: si ya hay un peer en estado estable o conectado, crear un answerer nuevo
                    // en lugar de intentar setRemoteDescription sobre uno en estado incorrecto
                    if (peerState === 'have-remote-offer' || peerState === 'stable') {
                        createAnswerer(offerSdp, peerUsername, sender_channel_name);
                    } else {
                        pd[0].setRemoteDescription(new RTCSessionDescription(offerSdp))
                            .then(() => pd[0].createAnswer())
                            .then(a => pd[0].setLocalDescription(a))
                            .then(() => sendSignal('new-answer', {
                                sdp: pd[0].localDescription,
                                target_channel_name: sender_channel_name,
                                isScreen: false
                            }))
                            .catch(e => {
                                console.error('Error en answer inline:', e);
                                createAnswerer(offerSdp, peerUsername, sender_channel_name);
                            });
                    }
                } else {
                    createAnswerer(offerSdp, peerUsername, sender_channel_name);
                }
            }
            return;
        }

        if (action == 'new-answer') {
            var answerSdp = messagePayload['sdp'] || parsedData['sdp'];
            var isScreen = messagePayload['isScreen'] || parsedData['isScreen'] || false;
            var pd = mapPeers[peerUsername];

            console.log('[WS] Nueva respuesta de:', peerUsername, 'screen:', isScreen);

            if (isScreen) {
                var sp = pd ? pd[2] : null;
                if (sp && sp.signalingState !== 'stable' && sp.signalingState !== 'closed') {
                    sp.setRemoteDescription(new RTCSessionDescription(answerSdp))
                        .catch(e => console.error('Error set remote desc screen:', e));
                }
            } else {
                var pr = pd ? pd[0] : null;
                if (pr && pr.signalingState !== 'stable' && pr.signalingState !== 'closed') {
                    pr.setRemoteDescription(new RTCSessionDescription(answerSdp))
                        .catch(e => console.error('Error set remote desc:', e));
                }
            }
            return;
        }

        if (action == 'ice-candidate') {
            var candidate = messagePayload['candidate'] || parsedData['candidate'];
            var isScreen = messagePayload['isScreen'] || parsedData['isScreen'] || false;
            var pd = mapPeers[peerUsername];
            if (!pd) return;
            var tp = isScreen ? pd[2] : pd[0];
            if (tp && candidate && tp.signalingState !== 'closed') {
                tp.addIceCandidate(new RTCIceCandidate(candidate))
                    .catch(e => console.warn('ICE candidate error:', e));
            }
            return;
        }

        if (action == 'screen-sharing-started') {
            console.log('[WS] Screen sharing iniciado por:', peerUsername);
            isAnyScreenSharing = true;
            screenSharerUsername = peerUsername;
            updateShareScreenBtn();
            setTimeout(() => {
                if (mapPeers[peerUsername]) {
                    sendSignal('request-screen-sdp', {
                        target_channel_name: mapPeers[peerUsername][3]
                    });
                }
            }, 1000);
            return;
        }

        if (action == 'request-screen-sdp') {
            console.log('[WS] Solicitud de screen SDP de:', peerUsername);
            if (isScreenSharing && screenStream) {
                if (!screenShareOfferSent[peerUsername]) {
                    screenShareOfferSent[peerUsername] = true;
                    createScreenOfferer(peerUsername, sender_channel_name);
                }
            }
            return;
        }

        if (action == 'screen-ice-candidate') {
            var pd = mapPeers[peerUsername];
            var sp = pd ? pd[2] : null;
            var c = messagePayload['candidate'] || parsedData['candidate'] || null;
            if (sp && c && sp.signalingState !== 'closed') {
                sp.addIceCandidate(new RTCIceCandidate(c))
                    .catch(e => console.warn('Screen ICE error:', e));
            }
            return;
        }

        if (action == 'peer-left') {
            var leftPeer = messagePayload['peer'] || parsedData['peer'];
            if (leftPeer && mapPeers[leftPeer]) {
                console.log('[Sistema] Peer salió:', leftPeer);
                if (mapPeers[leftPeer] && mapPeers[leftPeer][2]) {
                    try { mapPeers[leftPeer][2].close(); } catch(e) {}
                    mapPeers[leftPeer][2] = null;
                }
                if (screenSharerUsername === leftPeer) {
                    screenSharerUsername = null;
                    isAnyScreenSharing = false;
                    screenShareOfferSent = {};
                    updateShareScreenBtn();
                }
                cleanupPeer(leftPeer, mapPeers[leftPeer][0], document.getElementById(leftPeer + '-video'));
                updateTargetUserDropdown();
                delete screenShareOfferSent[leftPeer];
            }
            return;
        }

    } catch(e) {
        console.error('WS message error:', e);
    }
}

// ─── UI ─────────────────────────────────────────────────────────────────────────
function showConferenceUI() {
    try {
        ['waiting-screen', 'lobby-panel'].forEach(id => {
            var el = document.getElementById(id);
            if (el) el.style.setProperty('display', 'none', 'important');
        });
        var conf = document.getElementById('main-conference-area') || document.querySelector('.main-grid-container');
        if (conf) conf.style.setProperty('display', 'grid', 'important');
        var bar = document.getElementById('room-info-bar');
        if (bar) bar.style.setProperty('display', 'flex', 'important');
        var chat = document.getElementById('chat');
        if (chat) chat.style.setProperty('display', 'block', 'important');
        if (isMobile) injectMobileControlBar();
        updateParticipantsList();
    } catch(e) { console.warn('UI error:', e); }
}

function updateParticipantsList() {
    var listContainer = document.getElementById('participants-list');
    if (!listContainer) {
        var bar = document.getElementById('room-info-bar');
        if (bar) {
            var container = document.createElement('div');
            container.id = 'participants-list';
            container.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:4px 8px;font-size:0.8rem;';
            bar.appendChild(container);
            listContainer = container;
        }
    }
    if (!listContainer) return;

    listContainer.innerHTML = '';
    var title = document.createElement('span');
    title.style.cssText = 'color:#888;margin-right:8px;font-weight:bold;';
    title.innerText = '👥';
    listContainer.appendChild(title);

    var localBadge = document.createElement('span');
    localBadge.style.cssText = 'background:#2ecc71;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.7rem;margin:2px;';
    localBadge.innerText = username + ' (Tú)';
    listContainer.appendChild(localBadge);

    for (var p in mapPeers) {
        var badge = document.createElement('span');
        badge.style.cssText = 'background:#3498db;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.7rem;margin:2px;';
        badge.innerText = p;
        listContainer.appendChild(badge);
    }
}

function injectMobileControlBar() {
    if (document.getElementById('mobile-ctrl-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'mobile-ctrl-bar';
    bar.style.cssText = [
        'position:fixed', 'bottom:0', 'left:0', 'right:0',
        'background:rgba(22,22,28,0.98)', 'display:flex',
        'justify-content:space-around', 'align-items:center',
        'padding:6px 4px', 'z-index:9999',
        'border-top:1px solid #3a3a43', 'gap:4px',
        'backdrop-filter:blur(8px)'
    ].join(';');

    var controls = [
        { id: 'mb-audio', label: '🎤', action: () => document.querySelector('#btn-toggle-audio')?.click() },
        { id: 'mb-video', label: '📷', action: () => document.querySelector('#btn-toggle-video')?.click() },
        { id: 'mb-screen', label: '📺', action: handleMobileShare },
        { id: 'mb-reaction', label: '😊', action: () => {
            var tray = document.getElementById('emoji-tray');
            if (tray) tray.style.display = tray.style.display === 'none' ? 'flex' : 'none';
        }},
        { id: 'mb-leave', label: '🚪', action: () => document.getElementById('btn-leave-room')?.click() }
    ];

    controls.forEach(ctrl => {
        var btn = document.createElement('button');
        btn.id = ctrl.id;
        btn.innerHTML = ctrl.label;
        btn.style.cssText = [
            'background:transparent', 'color:#fff',
            'border:1px solid #4f545c', 'border-radius:10px',
            'padding:8px 4px', 'font-size:1.2rem',
            'cursor:pointer', 'flex:1', 'min-height:44px',
            'touch-action:manipulation', 'line-height:1',
            'transition:all 0.2s'
        ].join(';');
        btn.addEventListener('touchstart', () => { btn.style.transform = 'scale(0.92)'; });
        btn.addEventListener('touchend', () => { btn.style.transform = 'scale(1)'; });
        btn.addEventListener('click', ctrl.action);
        bar.appendChild(btn);
    });

    document.body.appendChild(bar);
    document.body.style.paddingBottom = '65px';
}

function updateShareScreenBtn() {
    var btn = document.querySelector('#btn-share-screen');
    var mbBtn = document.getElementById('mb-screen');
    if (btn) {
        if (isScreenSharing) {
            btn.innerText = '🛑 Dejar de compartir';
            btn.style.background = '#e74c3c';
        } else if (isAnyScreenSharing) {
            btn.innerText = '🔴 Pantalla ocupada por ' + (screenSharerUsername || 'otro');
            btn.style.background = '#7f8c8d';
        } else {
            btn.innerText = '📺 Compartir pantalla';
            btn.style.background = '#2ecc71';
        }
    }
    if (mbBtn) {
        if (isScreenSharing) { mbBtn.innerHTML = '🛑'; mbBtn.style.borderColor = '#e74c3c'; }
        else if (isAnyScreenSharing) { mbBtn.innerHTML = '🚫'; mbBtn.style.borderColor = '#7f8c8d'; }
        else { mbBtn.innerHTML = '📺'; mbBtn.style.borderColor = '#4f545c'; }
    }
}

// ─── CHAT ───────────────────────────────────────────────────────────────────────
function bindChatElements() {
    btnSendMsg = document.querySelector('#btn-send-msg');
    messageList = document.querySelector('#message-list');
    messageInput = document.querySelector('#msg');
    injectTargetUserSelect();
    updateTargetUserDropdown();
    if (btnSendMsg) {
        btnSendMsg.removeEventListener('click', sendMsgOnClick);
        btnSendMsg.addEventListener('click', sendMsgOnClick);
    }
    if (messageInput) {
        messageInput.removeEventListener('keydown', handleChatKeyDown);
        messageInput.addEventListener('keydown', handleChatKeyDown);
    }
}

function handleChatKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); sendMsgOnClick(); }
}

function injectTargetUserSelect() {
    if (document.getElementById('select-target-user')) {
        selectTargetUser = document.getElementById('select-target-user');
        return;
    }
    var sel = document.createElement('select');
    sel.id = 'select-target-user';
    sel.style.cssText = 'width:100%;padding:6px;margin-bottom:6px;background:#2f3136;color:#fff;border:1px solid #4f545c;border-radius:4px';
    if (messageInput && messageInput.parentNode) {
        messageInput.parentNode.insertBefore(sel, messageInput);
    }
    selectTargetUser = sel;
}

function updateTargetUserDropdown() {
    if (!selectTargetUser) return;
    var cur = selectTargetUser.value || 'public';
    selectTargetUser.innerHTML = '<option value="public">📣 Todos</option>';
    for (var p in mapPeers) {
        var opt = document.createElement('option');
        opt.value = p;
        opt.innerText = '🔒 ' + p;
        selectTargetUser.appendChild(opt);
    }
    if (selectTargetUser.querySelector(`option[value="${cur}"]`)) {
        selectTargetUser.value = cur;
    } else {
        selectTargetUser.value = 'public';
    }
}

function sendMsgOnClick() {
    if (!messageInput) bindChatElements();
    var text = messageInput ? messageInput.value.trim() : '';
    if (!text) return;

    var target = selectTargetUser ? selectTargetUser.value : 'public';
    var isPrivate = target !== 'public';
    var messageData = { text, is_private: isPrivate, recipient: isPrivate ? target : null };

    sendSignal('chat-message', messageData);

    var li = document.createElement('li');
    if (isPrivate) {
        li.style.cssText = 'color:#ff4d4d;font-weight:bold;background:rgba(255,77,77,0.05);border-left:3px solid #ff4d4d;padding:4px 8px';
        li.appendChild(document.createTextNode('[Privado para ' + target + ']: ' + text));
    } else {
        li.appendChild(document.createTextNode('Yo: ' + text));
    }
    if (messageList) messageList.appendChild(li);

    if (!isPrivate) {
        for (var p in mapPeers) {
            var dc = mapPeers[p][1];
            if (dc && dc.readyState === 'open') {
                try { dc.send(username + ': ' + text); } catch(e) {}
            }
        }
    } else {
        var raw = JSON.stringify({ type: 'private', to: target, from: username, msg: text });
        for (var p in mapPeers) {
            var dc = mapPeers[p][1];
            if (dc && dc.readyState === 'open') {
                try { dc.send(raw); } catch(e) {}
            }
        }
    }

    if (messageInput) messageInput.value = '';
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
}

// ─── DATA CHANNEL onMessage ──────────────────────────────────────────────────
function dcOnMessage(event) {
    var raw = event.data;
    if (raw === '__WAKEUP_PING__') return;

    if (raw === '__REQUEST_SCREEN__') {
        if (isScreenSharing && screenStream) {
            var peerUsername = null;
            for (var p in mapPeers) {
                if (mapPeers[p][1] === event.target) { peerUsername = p; break; }
            }
            if (peerUsername && mapPeers[peerUsername]) {
                var target_channel_name = mapPeers[peerUsername][3];
                if (target_channel_name) {
                    screenShareOfferSent[peerUsername] = true;
                    createScreenOfferer(peerUsername, target_channel_name);
                }
            }
        }
        return;
    }

    if (raw.startsWith('__SCREEN_STOPPED__:')) {
        var who = raw.split(':')[1];
        removeVideo(document.getElementById(who + '-screen-video'));
        isAnyScreenSharing = false;
        screenSharerUsername = null;
        screenShareOfferSent = {};
        updateShareScreenBtn();
        return;
    }

    if (raw.startsWith('__REACTION__:')) {
        try {
            var rdata = JSON.parse(raw.slice('__REACTION__:'.length));
            var emoji = rdata.e;
            var fromPeer = rdata.u;
            var mode = rdata.m;
            if (!fromPeer || fromPeer === username) return;
            if (mode === 'on') startPersistentReactionOnSlot(fromPeer, emoji);
            else if (mode === 'off') stopPersistentReactionOnSlot(fromPeer, emoji);
            else triggerFloatingReactionOnSlot(fromPeer, emoji, 10000);
        } catch(e) { console.error('Reaction parse error:', e, raw); }
        return;
    }

    try {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.type === 'private') {
            if (parsed.to.toLowerCase() === username.toLowerCase()) {
                if (!messageList) bindChatElements();
                var li = document.createElement('li');
                li.style.cssText = 'color:#ff4d4d;font-weight:bold;background:rgba(255,77,77,0.1);border-left:3px solid #ff4d4d;border-radius:4px;padding:6px';
                li.appendChild(document.createTextNode('[Privado de ' + parsed.from + ']: ' + parsed.msg));
                if (messageList) { messageList.appendChild(li); messageList.scrollTop = messageList.scrollHeight; }
                return;
            }
            return;
        }
    } catch(e) {}

    if (!messageList) bindChatElements();
    var li2 = document.createElement('li');
    li2.appendChild(document.createTextNode(raw));
    if (messageList) { messageList.appendChild(li2); messageList.scrollTop = messageList.scrollHeight; }
}

// ─── INIT APP ──────────────────────────────────────────────────────────────────
function initApp() {
    var localVideoEl = document.querySelector('#local-video');
    setupMediaToggleEvents(localVideoEl);
    bindChatElements();

    if (document.querySelector('#local-slot')) {
        appendUserLabelTag(document.querySelector('#local-slot'), 'Tú');
    }

    var btnCreate = document.getElementById('btn-create-room') || document.querySelector('#btn-create-room');
    if (btnCreate) {
        btnCreate.removeEventListener('click', handleCreateRoom);
        btnCreate.addEventListener('click', handleCreateRoom);
    }

    var btnJoin = document.getElementById('btn-request-join') || document.querySelector('#btn-request-join');
    if (btnJoin) {
        btnJoin.removeEventListener('click', handleJoinRoom);
        btnJoin.addEventListener('click', handleJoinRoom);
    }
}

function handleCreateRoom() {
    var usernameInput = document.getElementById('username') || document.querySelector('#username');
    username = usernameInput ? usernameInput.value.trim() : '';
    if (!username) { alert('⚠️ Ingresa tu nombre.'); return; }

    console.log('[Crear Sala] Usuario:', username, 'Admin: SI');
    isRoomAdmin = true;
    roomCode = 'ROOM-' + Math.random().toString(36).substring(2, 7).toUpperCase();

    showConferenceUI();

    var codeEl = document.getElementById('active-room-code') || document.querySelector('#active-room-code');
    if (codeEl) codeEl.innerText = roomCode;

    var badge = document.getElementById('admin-badge') || document.querySelector('#admin-badge');
    if (badge) badge.style.display = 'inline-block';

    var panel = document.getElementById('admin-notifications-panel') || document.querySelector('#admin-notifications-panel');
    if (panel) panel.style.display = 'block';

    var localSlot = document.querySelector('#local-slot');
    if (localSlot) appendUserLabelTag(localSlot, username + ' (Tú - Admin)');

    initializeMediaAfterApproval();
    bindChatElements();
    injectReactionPanel();
    initWebSocketConnection(() => {
        sendSignal('save-room', {});
        setTimeout(() => sendSignal('join-room-group', {}), 500);
        setTimeout(() => sendSignal('new-peer', {}), 1000);
    });
}

function handleJoinRoom() {
    var usernameInput = document.getElementById('username') || document.querySelector('#username');
    var roomCodeInput = document.getElementById('room-code-input') || document.querySelector('#room-code-input');

    username = usernameInput ? usernameInput.value.trim() : '';
    roomCode = roomCodeInput ? roomCodeInput.value.trim().toUpperCase() : '';

    if (!username || !roomCode) { alert('⚠️ Ingresa tu nombre y código.'); return; }

    console.log('[Unirse] Usuario:', username, 'Sala:', roomCode);

    var lobby = document.querySelector('#lobby-panel');
    if (lobby) lobby.style.display = 'none';

    var waiting = document.getElementById('waiting-screen');
    if (waiting) waiting.style.display = 'block';

    var localSlot = document.querySelector('#local-slot');
    if (localSlot) appendUserLabelTag(localSlot, username + ' (Tú)');

    var codeEl = document.getElementById('active-room-code') || document.querySelector('#active-room-code');
    if (codeEl) codeEl.innerText = roomCode;

    initWebSocketConnection(() => sendSignal('request-access', {}));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// ─── WebSocket ──────────────────────────────────────────────────────────────────
function initWebSocketConnection(onOpen) {
    var loc = window.location;
    var wsUrl = (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws/' + roomCode + '/';
    console.log('[WS] Conectando a:', wsUrl);

    webSocket = new WebSocket(wsUrl);
    webSocket.addEventListener('open', () => {
        console.log('[WS] ✅ Conectado a sala:', roomCode);
        if (onOpen) onOpen();
        startHeartbeat(5000);
    });
    webSocket.addEventListener('message', webSocketOnMessage);
    webSocket.addEventListener('close', (e) => {
        console.warn('[WS] Cerrado:', e.code);
        if (username && roomCode && !appIsBackground) {
            if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
            wsReconnectTimer = setTimeout(checkAndReconnect, 3000);
        }
    });
    webSocket.addEventListener('error', e => console.error('[WS] Error:', e));
}

// ─── SEÑALIZACIÓN ───────────────────────────────────────────────────────────────
function sendSignal(action, payload) {
    var msg = JSON.stringify({
        peer: username,
        action: action,
        room_code: roomCode,
        message: payload || {}
    });
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        try {
            webSocket.send(msg);
            console.log('[Signal] Enviado:', action);
            return true;
        } catch(e) {
            console.error('[Signal] Error:', e);
            return false;
        }
    } else {
        console.warn('[Signal] WS no disponible:', action);
        return false;
    }
}

// ─── MEDIA ──────────────────────────────────────────────────────────────────────
function initializeMediaAfterApproval() {
    var localVideoEl = document.querySelector('#local-video');
    if (localStream.getVideoTracks().length === 0) localStream.addTrack(createBlackVideoTrack());
    if (localStream.getAudioTracks().length === 0) localStream.addTrack(createSilentAudioTrack());
    if (localVideoEl) {
        localVideoEl.srcObject = localStream;
        localVideoEl.muted = true;
        localVideoEl.play().catch(() => {});
    }
}

function createBlackVideoTrack() {
    var c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#1e1e24';
    ctx.fillRect(0, 0, 640, 480);
    return c.captureStream(1).getVideoTracks()[0];
}

function createSilentAudioTrack() {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var gain = ctx.createGain();
    gain.gain.value = 0;
    var dst = ctx.createMediaStreamDestination();
    gain.connect(dst);
    var buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    src.start();
    return dst.stream.getAudioTracks()[0];
}

function setupMediaToggleEvents(localVideoEl) {
    var btnAudio = document.querySelector('#btn-toggle-audio');
    var btnVideo = document.querySelector('#btn-toggle-video');

    if (btnAudio) {
        btnAudio.addEventListener('click', async () => {
            if (!isAudioOn) {
                try {
                    var ms = await navigator.mediaDevices.getUserMedia({ audio: true });
                    originalMicStream = ms;
                    var t = ms.getAudioTracks()[0];
                    localStream.getAudioTracks().forEach(x => { x.stop(); localStream.removeTrack(x); });
                    localStream.addTrack(t);
                    replacePeerTrack('audio', t);
                    btnAudio.innerHTML = '🔇 Silenciar';
                    var mb = document.getElementById('mb-audio');
                    if (mb) mb.innerHTML = '🔇';
                    isAudioOn = true;
                } catch(e) { alert('Micrófono: ' + e.message); }
            } else {
                if (originalMicStream) originalMicStream.getAudioTracks().forEach(t => t.stop());
                localStream.getAudioTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
                var silent = createSilentAudioTrack();
                localStream.addTrack(silent);
                replacePeerTrack('audio', silent);
                btnAudio.innerHTML = '🎤 Mic';
                var mb = document.getElementById('mb-audio');
                if (mb) mb.innerHTML = '🎤';
                isAudioOn = false;
            }
        });
    }

    if (btnVideo) {
        btnVideo.addEventListener('click', async () => {
            if (!isVideoOn) {
                try {
                    var ms = await navigator.mediaDevices.getUserMedia({
                        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } }
                    });
                    originalCamStream = ms;
                    var t = ms.getVideoTracks()[0];
                    localStream.getVideoTracks().forEach(x => { x.stop(); localStream.removeTrack(x); });
                    localStream.addTrack(t);
                    if (localVideoEl) localVideoEl.srcObject = localStream;
                    replacePeerTrack('video', t);
                    btnVideo.innerHTML = '📷 Apagar';
                    var mb = document.getElementById('mb-video');
                    if (mb) mb.innerHTML = '📷';
                    isVideoOn = true;
                } catch(e) { alert('Cámara: ' + e.message); }
            } else {
                if (originalCamStream) originalCamStream.getVideoTracks().forEach(t => t.stop());
                localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
                var black = createBlackVideoTrack();
                localStream.addTrack(black);
                if (localVideoEl) localVideoEl.srcObject = localStream;
                replacePeerTrack('video', black);
                btnVideo.innerHTML = '📷 Cam';
                var mb = document.getElementById('mb-video');
                if (mb) mb.innerHTML = '📷';
                isVideoOn = false;
            }
        });
    }
}

function replacePeerTrack(kind, newTrack) {
    for (var p in mapPeers) {
        var peer = mapPeers[p][0];
        if (peer) {
            var s = peer.getSenders().find(s => s.track && s.track.kind === kind);
            if (s) s.replaceTrack(newTrack).catch(e => console.warn(e));
        }
    }
}

// ─── PEERS ──────────────────────────────────────────────────────────────────────
function createOfferer(peerUsername, target_channel_name) {
    console.log('[Peer] Creando offerer para:', peerUsername, 'canal:', target_channel_name);

    if (mapPeers[peerUsername] && mapPeers[peerUsername][0]) {
        var existingPeer = mapPeers[peerUsername][0];
        var state = existingPeer.connectionState || existingPeer.iceConnectionState;
        if (state === 'connected' || state === 'connecting') {
            // ✅ FIX: actualizar channel_name aunque ya esté conectado
            if (target_channel_name && !mapPeers[peerUsername][3]) {
                mapPeers[peerUsername][3] = target_channel_name;
            }
            console.log('[Peer] Ya existe peer conectado para', peerUsername);
            return;
        }
        try { existingPeer.close(); } catch(e) {}
        delete mapPeers[peerUsername];
    }

    if (!target_channel_name) {
        console.warn('[Peer] No hay target_channel_name para', peerUsername, '— abortando offerer');
        return;
    }

    var peer = new RTCPeerConnection(iceConfiguration);

    localStream.getTracks().forEach(t => {
        try { peer.addTrack(t, localStream); } catch(e) { console.warn('Error añadiendo track:', e); }
    });

    var dc = peer.createDataChannel('channel');
    dc.onopen = () => {
        console.log('[DC] ✅ Abierto con', peerUsername);
        try { dc.send('__WAKEUP_PING__'); } catch(e) {}
        resendActiveReactions(peerUsername);
        updateParticipantsList();
    };
    dc.onclose = () => {
        console.log('[DC] ❌ Cerrado con', peerUsername);
        updateParticipantsList();
    };
    dc.addEventListener('message', dcOnMessage);

    var remoteVideo = createVideo(peerUsername, peerUsername);
    setOnTrack(peer, remoteVideo);
    mapPeers[peerUsername] = [peer, dc, null, target_channel_name];
    updateTargetUserDropdown();
    updateParticipantsList();

    var offerTimeout = setTimeout(() => {
        if (peer.signalingState !== 'stable') {
            console.warn('[Peer] Timeout oferta para', peerUsername);
            peer.restartIce();
        }
    }, 15000);

    peer.addEventListener('icecandidate', ev => {
        if (ev.candidate) {
            sendSignal('ice-candidate', {
                candidate: ev.candidate,
                target_channel_name,
                isScreen: false
            });
        }
    });

    peer.addEventListener('iceconnectionstatechange', () => {
        console.log('[ICE offerer]', peerUsername, peer.iceConnectionState);
        if (peer.iceConnectionState === 'failed') peer.restartIce();
        if (peer.iceConnectionState === 'closed' || peer.iceConnectionState === 'disconnected') {
            cleanupPeer(peerUsername, peer, remoteVideo);
        }
    });

    peer.addEventListener('connectionstatechange', () => {
        console.log('[Conn offerer]', peerUsername, peer.connectionState);
        if (peer.connectionState === 'connected') {
            clearTimeout(offerTimeout);
            hideReconnectBanner();
            updateParticipantsList();
        }
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            cleanupPeer(peerUsername, peer, remoteVideo);
        }
    });

    peer.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true })
        .then(o => peer.setLocalDescription(o))
        .then(() => {
            console.log('[Peer] Enviando oferta a:', peerUsername);
            sendSignal('new-offer', {
                sdp: peer.localDescription,
                target_channel_name,
                isScreen: false
            });
        })
        .catch(e => {
            console.error('[Peer] Error createOffer:', e);
            clearTimeout(offerTimeout);
            cleanupPeer(peerUsername, peer, remoteVideo);
        });
}

function createAnswerer(offer, peerUsername, target_channel_name) {
    console.log('[Peer] Creando answerer para:', peerUsername, 'canal:', target_channel_name);

    // ✅ FIX: cerrar peer existente independientemente del estado antes de crear uno nuevo
    if (mapPeers[peerUsername] && mapPeers[peerUsername][0]) {
        var existingPeer = mapPeers[peerUsername][0];
        var state = existingPeer.connectionState || existingPeer.iceConnectionState;
        if (state === 'connected') {
            console.log('[Peer] Ya conectado con', peerUsername, '— ignorando oferta duplicada');
            return;
        }
        try { existingPeer.close(); } catch(e) {}
        delete mapPeers[peerUsername];
    }

    var peer = new RTCPeerConnection(iceConfiguration);

    localStream.getTracks().forEach(t => {
        try { peer.addTrack(t, localStream); } catch(e) { console.warn('Error añadiendo track:', e); }
    });

    var remoteVideo = createVideo(peerUsername, peerUsername);
    setOnTrack(peer, remoteVideo);

    // ✅ FIX: guardamos target_channel_name desde el inicio
    mapPeers[peerUsername] = [peer, null, null, target_channel_name];
    updateTargetUserDropdown();
    updateParticipantsList();

    peer.addEventListener('datachannel', e => {
        peer.dc = e.channel;
        peer.dc.addEventListener('message', dcOnMessage);
        peer.dc.onopen = () => {
            console.log('[DC] ✅ Abierto (answerer) con', peerUsername);
            resendActiveReactions(peerUsername);
            updateParticipantsList();
        };
        if (mapPeers[peerUsername]) mapPeers[peerUsername][1] = peer.dc;
        updateTargetUserDropdown();
    });

    peer.addEventListener('icecandidate', ev => {
        if (ev.candidate) {
            sendSignal('ice-candidate', {
                candidate: ev.candidate,
                target_channel_name,
                isScreen: false
            });
        }
    });

    peer.addEventListener('iceconnectionstatechange', () => {
        console.log('[ICE answerer]', peerUsername, peer.iceConnectionState);
        if (peer.iceConnectionState === 'failed') peer.restartIce();
        if (peer.iceConnectionState === 'closed' || peer.iceConnectionState === 'disconnected') {
            cleanupPeer(peerUsername, peer, remoteVideo);
        }
    });

    peer.addEventListener('connectionstatechange', () => {
        console.log('[Conn answerer]', peerUsername, peer.connectionState);
        if (peer.connectionState === 'connected') {
            hideReconnectBanner();
            updateParticipantsList();
        }
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            cleanupPeer(peerUsername, peer, remoteVideo);
        }
    });

    var answerTimeout = setTimeout(() => {
        if (peer.signalingState !== 'stable') {
            console.warn('[Peer] Timeout respuesta para', peerUsername);
            peer.restartIce();
        }
    }, 15000);

    peer.setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => peer.createAnswer({ offerToReceiveVideo: true, offerToReceiveAudio: true }))
        .then(a => peer.setLocalDescription(a))
        .then(() => {
            clearTimeout(answerTimeout);
            console.log('[Peer] Enviando respuesta a:', peerUsername);
            sendSignal('new-answer', {
                sdp: peer.localDescription,
                target_channel_name,
                isScreen: false
            });
        })
        .catch(e => {
            console.error('[Peer] Error createAnswer:', e);
            clearTimeout(answerTimeout);
            cleanupPeer(peerUsername, peer, remoteVideo);
        });
}

function resendActiveReactions(peerUsername) {
    if (!peerUsername || !mapPeers[peerUsername]) return;
    var dc = mapPeers[peerUsername][1];
    if (!dc || dc.readyState !== 'open') return;
    Object.keys(activeReactions).forEach(key => {
        if (key.startsWith('local_')) {
            var emoji = key.replace('local_', '');
            var payload = '__REACTION__:' + JSON.stringify({ e: emoji, u: username, m: 'on' });
            try { dc.send(payload); } catch(e) {}
        }
    });
}

function resendAllActiveReactions() {
    Object.keys(activeReactions).forEach(key => {
        if (key.startsWith('local_')) {
            broadcastReaction(key.replace('local_', ''), 'on');
        }
    });
}

function cleanupPeer(peerUsername, peer, videoEl) {
    console.log('[Cleanup] Eliminando peer:', peerUsername);

    if (mapPeers[peerUsername] && mapPeers[peerUsername][2]) {
        try { mapPeers[peerUsername][2].close(); } catch(e) {}
        if (isScreenSharing && peerUsername === username) stopScreenShare();
        mapPeers[peerUsername][2] = null;
    }

    delete mapPeers[peerUsername];
    delete screenShareOfferSent[peerUsername];

    try {
        if (peer) {
            peer.oniceconnectionstatechange = null;
            peer.onconnectionstatechange = null;
            peer.close();
        }
    } catch(e) {}

    removeVideo(videoEl);
    updateTargetUserDropdown();
    updateParticipantsList();
    setTimeout(checkScreenSharingStatus, 500);
}

// ─── VIDEO DOM ──────────────────────────────────────────────────────────────────
function createVideo(peerUsername, displayName) {
    var container = document.querySelector('#video-container');
    var existing = document.getElementById(peerUsername + '-video');
    if (existing) return existing;

    var wrapper = document.createElement('div');
    wrapper.className = 'video-slot';
    wrapper.id = peerUsername + '-slot';
    wrapper.style.cssText = 'background:#1e1e24;border:2px solid #3a3a43;border-radius:8px;position:relative;min-height:200px;overflow:hidden';

    var video = document.createElement('video');
    video.id = peerUsername + '-video';
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.style.cssText = 'width:100%;height:100%;object-fit:cover';

    wrapper.appendChild(video);
    if (container) container.appendChild(wrapper);
    appendUserLabelTag(wrapper, displayName);
    return video;
}

function setOnTrack(peer, remoteVideo) {
    var remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;
    peer.addEventListener('track', ev => {
        console.log('[Track] Recibido track:', ev.track.kind);
        remoteStream.addTrack(ev.track);
        remoteVideo.play().catch(() => {});
    });
}

function removeVideo(video) {
    if (video && video.parentNode && video.parentNode.parentNode) {
        video.parentNode.parentNode.removeChild(video.parentNode);
    }
}

function appendUserLabelTag(container, labelText) {
    if (!container) return;
    var exist = container.querySelector('.user-name-tag');
    if (exist) { exist.innerText = labelText; return; }
    var tag = document.createElement('div');
    tag.className = 'user-name-tag';
    tag.style.cssText = 'position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.7);color:#fff;padding:4px 10px;border-radius:4px;font-size:0.85rem;z-index:10;pointer-events:none';
    tag.innerText = labelText;
    container.appendChild(tag);
}

// ─── ACCESO ─────────────────────────────────────────────────────────────────────
function showAccessRequest(peerName, clientChannel) {
    var list = document.querySelector('#requests-list');
    if (!list || document.getElementById('req-' + peerName)) return;
    var item = document.createElement('div');
    item.className = 'request-item';
    item.id = 'req-' + peerName;
    item.innerHTML = `<span><strong>${peerName}</strong> solicita entrar.</span>
        <div class="request-buttons">
            <button class="btn-approve" onclick="window.respondRequest('${peerName}','approved','${clientChannel}')">✅ Admitir</button>
            <button class="btn-deny" onclick="window.respondRequest('${peerName}','rejected','${clientChannel}')">❌ Rechazar</button>
        </div>`;
    list.appendChild(item);
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
}

window.respondRequest = function(peerName, decision, clientChannel) {
    var el = document.getElementById('req-' + peerName);
    if (el) el.remove();
    if (decision === 'approved') {
        isProcessingApproval = true;
        document.querySelectorAll('.request-buttons button').forEach(b => {
            b.disabled = true;
            b.style.opacity = '0.5';
        });
        setTimeout(() => { isProcessingApproval = false; }, 4000);
    }
    sendSignal('access-response', {
        target_channel_name: clientChannel,
        status: decision
    });
};

// ─── REACCIONES ─────────────────────────────────────────────────────────────────
function injectReactionPanel() {
    if (document.getElementById('reaction-container-box')) return;

    if (!document.getElementById('reaction-anim-style')) {
        var style = document.createElement('style');
        style.id = 'reaction-anim-style';
        style.textContent = `
            @keyframes reactionPulse {
                0%   { transform: translateX(-50%) scale(1); opacity: 1; }
                50%  { transform: translateX(-50%) scale(1.5); opacity: 0.9; }
                100% { transform: translateX(-50%) scale(1); opacity: 1; }
            }
            @keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
            .emoji-btn-active {
                outline: 3px solid #7289da !important;
                border-radius: 8px !important;
                background: rgba(114,137,218,0.2) !important;
                transform: scale(1.1) !important;
            }
            .reaction-emoji-btn {
                background: transparent !important;
                border: none !important;
                font-size: 1.7rem !important;
                cursor: pointer !important;
                padding: 4px 5px !important;
                border-radius: 6px !important;
                touch-action: manipulation !important;
                transition: transform 0.15s, background 0.15s !important;
            }
            .reaction-emoji-btn:hover { transform: scale(1.3) !important; }
            .reaction-emoji-btn:active { transform: scale(0.9) !important; }
        `;
        document.head.appendChild(style);
    }

    var container = document.createElement('div');
    container.id = 'reaction-container-box';
    container.style.cssText = [
        'position:fixed',
        'bottom:' + (isMobile ? '75px' : '24px'),
        'right:16px', 'z-index:1001',
        'display:flex', 'flex-direction:column',
        'align-items:flex-end', 'gap:8px'
    ].join(';');

    var tray = document.createElement('div');
    tray.id = 'emoji-tray';
    tray.style.cssText = [
        'display:' + (isMobile ? 'none' : 'flex'),
        'gap:4px', 'background:rgba(20,20,26,0.95)',
        'padding:8px 12px', 'border-radius:24px',
        'flex-wrap:wrap', 'max-width:240px',
        'justify-content:center', 'border:1px solid #3a3a43',
        'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
        'backdrop-filter:blur(8px)'
    ].join(';');

    var emojis = ['✋', '❤️', '🔥', '🎉', '🚀', '👏', '😂', '🙌', '😱', '💪'];
    emojis.forEach(emoji => {
        var btn = document.createElement('button');
        btn.className = 'reaction-emoji-btn';
        btn.setAttribute('data-emoji', emoji);
        btn.innerText = emoji;
        btn.title = '1 tap = flotar 10s | 2 taps = toggle permanente';

        var tapTimer = null;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (tapTimer !== null) {
                clearTimeout(tapTimer);
                tapTimer = null;
                toggleEmojiReaction(emoji, btn);
            } else {
                tapTimer = setTimeout(() => {
                    tapTimer = null;
                    sendEmojiReaction(emoji);
                }, 400);
            }
        });
        tray.appendChild(btn);
    });

    var openBtn = document.createElement('button');
    openBtn.id = 'reaction-toggle-btn';
    openBtn.innerText = '😊';
    openBtn.style.cssText = [
        'background:rgba(20,20,26,0.95)', 'border:1px solid #3a3a43',
        'font-size:1.6rem', 'cursor:pointer', 'width:52px', 'height:52px',
        'border-radius:50%', 'display:flex', 'align-items:center',
        'justify-content:center', 'box-shadow:0 2px 12px rgba(0,0,0,0.5)',
        'touch-action:manipulation', 'transition:transform 0.2s'
    ].join(';');
    openBtn.addEventListener('click', () => {
        var isVisible = tray.style.display !== 'none';
        tray.style.display = isVisible ? 'none' : 'flex';
        openBtn.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(90deg)';
    });

    var hint = document.createElement('div');
    hint.style.cssText = 'color:rgba(255,255,255,0.3);font-size:0.55rem;text-align:right;padding-right:4px';
    hint.innerText = '1=10s | 2=toggle';

    container.appendChild(tray);
    container.appendChild(openBtn);
    container.appendChild(hint);
    document.body.appendChild(container);
}

function sendEmojiReaction(emoji) {
    triggerFloatingReactionOnSlot('local', emoji, 10000);
    broadcastReaction(emoji, 'pulse');
}

function toggleEmojiReaction(emoji, btnEl) {
    var key = 'local_' + emoji;
    if (activeReactions[key]) {
        stopPersistentReactionOnSlot('local', emoji);
        if (btnEl) btnEl.classList.remove('emoji-btn-active');
        broadcastReaction(emoji, 'off');
    } else {
        startPersistentReactionOnSlot('local', emoji);
        if (btnEl) btnEl.classList.add('emoji-btn-active');
        broadcastReaction(emoji, 'on');
    }
}

function broadcastReaction(emoji, mode) {
    var payload = '__REACTION__:' + JSON.stringify({ e: emoji, u: username, m: mode });
    for (var p in mapPeers) {
        var dc = mapPeers[p][1];
        if (dc && dc.readyState === 'open') {
            try { dc.send(payload); } catch(e) {}
        } else {
            (function(capturedDc, capturedPayload) {
                setTimeout(() => {
                    if (capturedDc && capturedDc.readyState === 'open') {
                        try { capturedDc.send(capturedPayload); } catch(e) {}
                    }
                }, 1000);
            })(dc, payload);
        }
    }
}

function triggerFloatingReactionOnSlot(peerKey, emoji, duration) {
    duration = duration || 10000;
    var normalKey = (peerKey === 'local' || peerKey === username) ? 'local' : peerKey;
    var slotId = normalKey === 'local' ? 'local-slot' : normalKey + '-slot';
    var slot = document.getElementById(slotId) || document.getElementById('video-container') || document.querySelector('.main-grid-container');
    if (!slot) return;

    var el = document.createElement('div');
    el.innerText = emoji;
    var leftPct = 15 + Math.random() * 70;
    el.style.cssText = [
        'position:absolute', 'bottom:44px',
        'left:' + leftPct + '%', 'transform:translateX(-50%)',
        'font-size:' + (2.4 + Math.random() * 0.8) + 'rem',
        'z-index:200', 'pointer-events:none', 'opacity:1',
        'text-shadow:0 2px 8px rgba(0,0,0,0.5)'
    ].join(';');
    slot.appendChild(el);

    var start = Date.now();
    var frame = setInterval(() => {
        var p = Math.min((Date.now() - start) / duration, 1);
        el.style.bottom = (44 + 140 * p) + 'px';
        el.style.opacity = p > 0.7 ? (1 - (p - 0.7) / 0.3).toString() : '1';
        if (p >= 1) { clearInterval(frame); if (el.parentNode) el.parentNode.removeChild(el); }
    }, 40);
}

function startPersistentReactionOnSlot(peerKey, emoji) {
    var normalKey = (peerKey === 'local' || peerKey === username) ? 'local' : peerKey;
    var key = normalKey + '_' + emoji;
    if (activeReactions[key]) return;

    var slotId = normalKey === 'local' ? 'local-slot' : normalKey + '-slot';
    var slot = document.getElementById(slotId);
    if (!slot) return;

    var el = document.createElement('div');
    el.id = 'pr_' + key.replace(/[^\w]/g, '_');
    el.innerText = emoji;
    el.style.cssText = [
        'position:absolute', 'bottom:44px', 'left:50%',
        'transform:translateX(-50%)', 'font-size:3rem',
        'z-index:200', 'pointer-events:none',
        'animation:reactionPulse 1.4s ease-in-out infinite',
        'text-shadow:0 2px 12px rgba(0,0,0,0.6)'
    ].join(';');

    slot.appendChild(el);
    activeReactions[key] = { el };
}

function stopPersistentReactionOnSlot(peerKey, emoji) {
    var normalKey = (peerKey === 'local' || peerKey === username) ? 'local' : peerKey;
    var key = normalKey + '_' + emoji;
    if (!activeReactions[key]) return;
    var el = activeReactions[key].el;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    delete activeReactions[key];
}

// ─── COMPARTIR PANTALLA ─────────────────────────────────────────────────────────
var btnShareScreen = document.querySelector('#btn-share-screen');
if (btnShareScreen) {
    btnShareScreen.addEventListener('click', async () => {
        if (isScreenSharing) { stopScreenShare(); return; }
        if (isAnyScreenSharing) {
            alert('⚠️ ' + (screenSharerUsername || 'Alguien') + ' ya está compartiendo pantalla.');
            return;
        }
        await startScreenShare();
    });
}

function handleMobileShare() {
    if (isScreenSharing) { stopScreenShare(); return; }
    if (isAnyScreenSharing) {
        alert('⚠️ ' + (screenSharerUsername || 'Alguien') + ' ya está compartiendo.');
        return;
    }
    showMobileShareMenu();
}

function showMobileShareMenu() {
    var existing = document.getElementById('mobile-share-menu');
    if (existing) { existing.remove(); return; }

    var menu = document.createElement('div');
    menu.id = 'mobile-share-menu';
    menu.style.cssText = [
        'position:fixed', 'bottom:75px', 'left:50%', 'transform:translateX(-50%)',
        'background:#1e1e24', 'border:1px solid #4f545c', 'border-radius:16px',
        'padding:16px', 'z-index:99999', 'display:flex', 'flex-direction:column',
        'gap:10px', 'min-width:280px', 'max-width:90%',
        'box-shadow:0 8px 40px rgba(0,0,0,0.8)'
    ].join(';');

    var title = document.createElement('div');
    title.style.cssText = 'color:#fff;font-weight:bold;text-align:center;font-size:1.1rem;padding-bottom:6px;border-bottom:1px solid #3a3a43;margin-bottom:4px';
    title.innerText = '📱 Compartir';
    menu.appendChild(title);

    var options = [
        {
            label: '📺 Pantalla del celular', sub: 'Comparte toda tu pantalla',
            action: async () => { menu.remove(); await startScreenShare(); }
        },
        {
            label: '📷 Cámara trasera', sub: 'Muestra lo que ves',
            action: () => { menu.remove(); startCameraShare({ facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, '📷 Trasera'); }
        },
        {
            label: '🤳 Cámara frontal', sub: 'Selfie para los demás',
            action: () => { menu.remove(); startCameraShare({ facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, '🤳 Frontal'); }
        }
    ];

    options.forEach(opt => {
        var btn = document.createElement('button');
        btn.style.cssText = [
            'background:#2f3136', 'color:#fff', 'border:1px solid #4f545c',
            'border-radius:10px', 'padding:14px 16px', 'font-size:0.95rem',
            'cursor:pointer', 'text-align:left', 'touch-action:manipulation',
            'display:flex', 'flex-direction:column', 'gap:2px', 'transition:all 0.2s'
        ].join(';');
        var labelEl = document.createElement('span');
        labelEl.innerText = opt.label;
        labelEl.style.fontWeight = 'bold';
        var subEl = document.createElement('span');
        subEl.style.cssText = 'font-size:0.7rem;color:#888';
        subEl.innerText = opt.sub;
        btn.appendChild(labelEl);
        btn.appendChild(subEl);
        btn.addEventListener('touchstart', () => { btn.style.transform = 'scale(0.97)'; btn.style.background = '#3a3a45'; });
        btn.addEventListener('touchend', () => { btn.style.transform = 'scale(1)'; btn.style.background = '#2f3136'; });
        btn.addEventListener('click', opt.action);
        menu.appendChild(btn);
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.innerText = '✕ Cancelar';
    cancelBtn.style.cssText = 'background:none;color:#888;border:none;padding:10px;cursor:pointer;font-size:0.9rem;text-align:center;margin-top:4px';
    cancelBtn.addEventListener('click', () => menu.remove());
    menu.appendChild(cancelBtn);
    document.body.appendChild(menu);
}

async function startScreenShare() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            throw new Error('getDisplayMedia no soportado en este navegador');
        }
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15 } },
            audio: false,
            cursor: 'always'
        });

        var screenTrack = screenStream.getVideoTracks()[0];
        if (!screenTrack) throw new Error('No se obtuvo track de video');

        var myVid = createVideo(username + '-screen', username + ' 📺 Pantalla');
        myVid.srcObject = screenStream;
        myVid.muted = true;
        myVid.play().catch(() => {});

        isScreenSharing = true;
        isAnyScreenSharing = true;
        screenSharerUsername = username;
        screenShareOfferSent = {};
        updateShareScreenBtn();

        sendSignal('screen-sharing-started', {});
        sendSignal('global-screen-occupied', {});

        screenTrack.onended = () => stopScreenShare();

        setTimeout(() => {
            for (var p in mapPeers) {
                if (p !== username) sendScreenShareToNewPeer(p);
            }
        }, 1000);

    } catch(e) {
        console.error('[ScreenShare] Error:', e);
        if (isMobile) {
            var useCamera = confirm('📱 No se pudo compartir pantalla.\nError: ' + e.message + '\n\n¿Usar cámara trasera?');
            if (useCamera) {
                startCameraShare({ facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, '📷 Trasera');
            } else {
                startCameraShare({ facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, '🤳 Frontal');
            }
        } else {
            alert('❌ No se pudo compartir pantalla: ' + e.message);
        }
        isScreenSharing = false;
        updateShareScreenBtn();
    }
}

async function startCameraShare(videoConstraints, label) {
    try {
        var camStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
        screenStream = camStream;

        var myVid = createVideo(username + '-screen', username + ' ' + label);
        myVid.srcObject = camStream;
        myVid.muted = true;
        myVid.play().catch(() => {});

        isScreenSharing = true;
        isAnyScreenSharing = true;
        screenSharerUsername = username;
        screenShareOfferSent = {};
        updateShareScreenBtn();

        sendSignal('screen-sharing-started', {});
        sendSignal('global-screen-occupied', {});

        camStream.getVideoTracks()[0].onended = () => stopScreenShare();

        setTimeout(() => {
            for (var p in mapPeers) {
                if (p !== username) sendScreenShareToNewPeer(p);
            }
        }, 1000);

    } catch(e) {
        console.error('[CameraShare] Error:', e);
        alert('❌ No se pudo acceder a la cámara: ' + e.message);
        isScreenSharing = false;
        updateShareScreenBtn();
    }
}

function stopScreenShare() {
    if (!isScreenSharing) return;

    if (screenStream) {
        try {
            screenStream.getTracks().forEach(t => { t.stop(); t.onended = null; });
        } catch(e) {}
        screenStream = null;
    }

    for (var p in mapPeers) {
        var dc = mapPeers[p][1];
        if (dc && dc.readyState === 'open') {
            try { dc.send('__SCREEN_STOPPED__:' + username); } catch(e) {}
        }
        if (mapPeers[p] && mapPeers[p][2]) {
            try { mapPeers[p][2].close(); mapPeers[p][2] = null; } catch(e) {}
        }
    }

    var screenVideo = document.getElementById(username + '-screen-video');
    if (screenVideo) removeVideo(screenVideo);

    isScreenSharing = false;
    isAnyScreenSharing = false;
    screenSharerUsername = null;
    screenShareOfferSent = {};
    updateShareScreenBtn();
    sendSignal('global-screen-released', {});
}

// ─── SCREEN PEERS ──────────────────────────────────────────────────────────────
function createScreenOfferer(peerUsername, target_channel_name) {
    if (!target_channel_name || !screenStream) return;

    if (mapPeers[peerUsername] && mapPeers[peerUsername][2]) {
        try { mapPeers[peerUsername][2].close(); } catch(e) {}
        mapPeers[peerUsername][2] = null;
    }

    var peer = new RTCPeerConnection(iceConfiguration);
    screenStream.getTracks().forEach(t => {
        try { peer.addTrack(t, screenStream); } catch(e) {}
    });

    if (mapPeers[peerUsername]) mapPeers[peerUsername][2] = peer;

    peer.addEventListener('icecandidate', ev => {
        if (ev.candidate) {
            sendSignal('ice-candidate', { candidate: ev.candidate, target_channel_name, isScreen: true });
        }
    });

    peer.addEventListener('iceconnectionstatechange', () => {
        if (peer.iceConnectionState === 'failed') peer.restartIce();
        if (peer.iceConnectionState === 'closed' || peer.iceConnectionState === 'disconnected') {
            try { peer.close(); } catch(e) {}
            if (mapPeers[peerUsername]) mapPeers[peerUsername][2] = null;
            checkScreenSharingStatus();
        }
    });

    peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            try { peer.close(); } catch(e) {}
            if (mapPeers[peerUsername]) mapPeers[peerUsername][2] = null;
            checkScreenSharingStatus();
        }
    });

    peer.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false })
        .then(o => peer.setLocalDescription(o))
        .then(() => {
            sendSignal('new-offer', { sdp: peer.localDescription, target_channel_name, isScreen: true });
        })
        .catch(e => {
            console.error('[Screen] Error createOffer:', e);
            if (mapPeers[peerUsername]) mapPeers[peerUsername][2] = null;
        });
}

function createScreenAnswerer(offer, peerUsername, target_channel_name, remoteScreenVideo) {
    if (mapPeers[peerUsername] && mapPeers[peerUsername][2]) {
        try { mapPeers[peerUsername][2].close(); } catch(e) {}
        mapPeers[peerUsername][2] = null;
    }

    var peer = new RTCPeerConnection(iceConfiguration);
    setOnTrack(peer, remoteScreenVideo);
    if (mapPeers[peerUsername]) mapPeers[peerUsername][2] = peer;

    peer.addEventListener('iceconnectionstatechange', () => {
        if (peer.iceConnectionState === 'failed') peer.restartIce();
        if (peer.iceConnectionState === 'closed' || peer.iceConnectionState === 'disconnected') {
            try { peer.close(); } catch(e) {}
            removeVideo(remoteScreenVideo);
            if (mapPeers[peerUsername]) mapPeers[peerUsername][2] = null;
            checkScreenSharingStatus();
        }
    });

    peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            try { peer.close(); } catch(e) {}
            removeVideo(remoteScreenVideo);
            if (mapPeers[peerUsername]) mapPeers[peerUsername][2] = null;
            checkScreenSharingStatus();
        }
    });

    peer.addEventListener('icecandidate', ev => {
        if (ev.candidate) {
            sendSignal('ice-candidate', { candidate: ev.candidate, target_channel_name, isScreen: true });
        }
    });

    peer.setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => peer.createAnswer({ offerToReceiveVideo: true, offerToReceiveAudio: false }))
        .then(a => peer.setLocalDescription(a))
        .then(() => {
            sendSignal('new-answer', { sdp: peer.localDescription, target_channel_name, isScreen: true });
        })
        .catch(e => console.error('[Screen] Error createAnswer:', e));
}

// ─── CHECK PERIÓDICO ──────────────────────────────────────────────────────────
setInterval(() => {
    if (Object.keys(mapPeers).length > 0) checkScreenSharingStatus();
}, 10000);

// ─── SALIR ──────────────────────────────────────────────────────────────────────
var btnLeave = document.getElementById('btn-leave-room');
if (btnLeave) {
    btnLeave.addEventListener('click', () => {
        if (confirm('¿Deseas salir de la reunión?')) {
            stopHeartbeat();
            if (localStream) localStream.getTracks().forEach(t => t.stop());
            if (isScreenSharing) stopScreenShare();

            Object.keys(mapPeers).forEach(p => {
                try { if (mapPeers[p][0]) { mapPeers[p][0].oniceconnectionstatechange = null; mapPeers[p][0].close(); } } catch(e) {}
                try { if (mapPeers[p][2]) { mapPeers[p][2].oniceconnectionstatechange = null; mapPeers[p][2].close(); } } catch(e) {}
            });
            mapPeers = {};

            if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                try {
                    webSocket.send(JSON.stringify({
                        peer: username,
                        action: 'leave-room-group',
                        room_code: roomCode,
                        message: {}
                    }));
                } catch(e) {}
                webSocket.close();
            }

            window.location.reload();
        }
    });
}

console.log('✅ main.js v6.7 - Multi-Peer Fixed');