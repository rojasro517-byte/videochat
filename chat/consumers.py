import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import Room, Participant, ChatMessage, ScreenShareHistory, ReactionLog
from django.utils import timezone
import logging

logger = logging.getLogger(__name__)

class VideoChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room_code = self.scope['url_route']['kwargs'].get('room_code')
        if not self.room_code:
            self.room_code = 'default'

        self.room_group_name = f'videochat_{self.room_code}'
        self.username = None

        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept()
        logger.info(f"[CONNECT] Cliente conectado a sala {self.room_code}")

    async def disconnect(self, close_code):
        if self.username and self.room_code:
            await self.update_participant_status(self.username, False)
            await self.update_room_participant_count(self.room_code, -1)

        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )
        logger.info(f"[DISCONNECT] Cliente desconectado de sala {self.room_code}")

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            action = data.get('action')
            peer = data.get('peer')
            room_code = data.get('room_code') or self.room_code
            message = data.get('message', {})

            logger.info(f"[RECEIVE] Acción: {action} | Peer: {peer} | Sala: {room_code}")

            if peer and not self.username:
                self.username = peer

            # ── save-room ────────────────────────────────────────────────────
            if action == 'save-room':
                logger.info(f"[save-room] Guardando sala {room_code} para {peer}")
                await self.save_room(room_code, peer)
                await self.send(text_data=json.dumps({
                    'peer': 'system',
                    'action': 'room-saved',
                    'message': {'status': 'success', 'room_code': room_code}
                }))

            # ── join-room-group ───────────────────────────────────────────────
            elif action == 'join-room-group':
                logger.info(f"[join-room-group] {peer} uniéndose a {room_code}")
                await self.save_room(room_code, peer)
                await self.register_participant(room_code, peer)

                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'forward_message',
                        'data': {
                            'peer': peer,
                            'action': 'join-room-group',
                            'room_code': room_code,
                            'message': message,
                            'sender_channel_name': self.channel_name
                        }
                    }
                )

            # ── new-peer ──────────────────────────────────────────────────────
            # CRÍTICO: broadcast con sender_channel_name para que los peers
            # existentes puedan enviar offers directamente a C.
            elif action == 'new-peer':
                logger.info(f"[new-peer] Nuevo peer: {peer} en {room_code}")
                await self.register_participant(room_code, peer)

                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'forward_message',
                        'data': {
                            'peer': peer,
                            'action': 'new-peer',
                            'room_code': room_code,
                            'message': message,
                            'sender_channel_name': self.channel_name  # ← CRÍTICO
                        }
                    }
                )

            # ── request-access ────────────────────────────────────────────────
            elif action == 'request-access':
                logger.info(f"[request-access] {peer} solicitando acceso a {room_code}")

                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'forward_message',
                        'data': {
                            'peer': peer,
                            'action': 'request-access',
                            'room_code': room_code,
                            'message': message,
                            'sender_channel_name': self.channel_name
                        }
                    }
                )

            # ── access-response ───────────────────────────────────────────────
            # Envío directo al solicitante, no broadcast
            elif action == 'access-response':
                target_channel = message.get('target_channel_name') if isinstance(message, dict) else None
                status = message.get('status') if isinstance(message, dict) else None
                logger.info(f"[access-response] {peer} respondió {status} a canal {target_channel}")

                if target_channel:
                    await self.channel_layer.send(
                        target_channel,
                        {
                            'type': 'forward_message',
                            'data': {
                                'peer': peer,
                                'action': 'access-response',
                                'room_code': room_code,
                                'status': status,
                                'message': message,
                                'sender_channel_name': self.channel_name
                            }
                        }
                    )
                else:
                    logger.warning(f"[access-response] Sin target_channel_name, no se puede responder")

            # ── chat-message ──────────────────────────────────────────────────
            elif action == 'chat-message':
                logger.info(f"[chat-message] {peer} envió: {message.get('text', '')[:30]}...")

                await self.save_chat_message(
                    room_code=room_code,
                    username=peer,
                    message_text=message.get('text', ''),
                    is_private=message.get('is_private', False),
                    recipient=message.get('recipient', None)
                )

                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'forward_message',
                        'data': {
                            'peer': peer,
                            'action': 'chat-message',
                            'room_code': room_code,
                            'message': message,
                            'sender_channel_name': self.channel_name
                        }
                    }
                )

            # ── leave-room-group ──────────────────────────────────────────────
            elif action == 'leave-room-group':
                logger.info(f"[leave-room-group] {peer} saliendo de {room_code}")
                await self.update_participant_status(peer, False)
                await self.update_room_participant_count(room_code, -1)

                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'forward_message',
                        'data': {
                            'peer': peer,
                            'action': 'peer-left',
                            'room_code': room_code,
                            'message': {'peer': peer},
                            'sender_channel_name': self.channel_name
                        }
                    }
                )

            # ── ping ──────────────────────────────────────────────────────────
            elif action == 'ping':
                await self.send(text_data=json.dumps({
                    'peer': 'system',
                    'action': 'pong',
                    'room_code': room_code,
                    'message': {}
                }))

            # ── señalización WebRTC y señales globales ────────────────────────
            # new-offer, new-answer, ice-candidate, screen-sharing-started,
            # global-screen-occupied, global-screen-released, request-screen-sdp
            else:
                target_channel = message.get('target_channel_name') if isinstance(message, dict) else None

                if target_channel:
                    # Envío directo: solo el destinatario recibe la señal.
                    # CRÍTICO: así new-offer/new-answer/ice-candidate no llegan
                    # a todos los peers, evitando colisiones con el 3er participante.
                    logger.info(f"[{action}] Envío directo de {peer} → canal {target_channel}")
                    await self.channel_layer.send(
                        target_channel,
                        {
                            'type': 'forward_message',
                            'data': {
                                **data,
                                'sender_channel_name': self.channel_name
                            }
                        }
                    )
                else:
                    # Broadcast: señales globales sin destinatario específico
                    # (global-screen-occupied, global-screen-released, etc.)
                    logger.info(f"[{action}] Broadcast de {peer} a sala {room_code}")
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'forward_message',
                            'data': {
                                **data,
                                'sender_channel_name': self.channel_name
                            }
                        }
                    )

        except Exception as e:
            logger.error(f"[ERROR] receive: {e}", exc_info=True)
            await self.send(text_data=json.dumps({
                'peer': 'system',
                'action': 'error',
                'message': {'error': str(e)}
            }))

    async def forward_message(self, event):
        data = event['data']
        # Solo inyecta sender_channel_name si no viene ya en el payload.
        # Preservar el original es CRÍTICO para que el receptor sepa
        # a qué canal responder (el del remitente, no el nuestro).
        if 'sender_channel_name' not in data:
            data['sender_channel_name'] = self.channel_name
        await self.send(text_data=json.dumps(data))

    # ── Base de datos ─────────────────────────────────────────────────────────

    @database_sync_to_async
    def save_room(self, room_code, admin_username):
        try:
            if not room_code:
                return None

            room, created = Room.objects.get_or_create(
                room_code=room_code,
                defaults={
                    'admin_username': admin_username or 'admin',
                    'is_active': True,
                    'current_participants': 0
                }
            )
            if not created:
                room.is_active = True
                room.save()

            logger.info(f"[DB] Sala {room_code} guardada. Creada: {created}")
            return room
        except Exception as e:
            logger.error(f"[DB ERROR] save_room: {e}")
            return None

    @database_sync_to_async
    def register_participant(self, room_code, username):
        try:
            if not room_code or not username:
                return None

            room = Room.objects.get(room_code=room_code)
            participant, created = Participant.objects.get_or_create(
                room=room,
                username=username,
                defaults={
                    'is_active': True,
                    'is_screen_sharing': False
                }
            )
            if not created:
                participant.is_active = True
                participant.left_at = None
                participant.save()

            logger.info(f"[DB] Participante {username} registrado en sala {room_code}")
            return participant
        except Room.DoesNotExist:
            logger.error(f"[DB ERROR] Sala {room_code} no existe")
            return None
        except Exception as e:
            logger.error(f"[DB ERROR] register_participant: {e}")
            return None

    @database_sync_to_async
    def update_participant_status(self, username, is_active):
        try:
            room = Room.objects.get(room_code=self.room_code)
            participant = Participant.objects.get(room=room, username=username)
            participant.is_active = is_active
            if not is_active:
                participant.left_at = timezone.now()
            participant.save()
            return True
        except Exception as e:
            logger.error(f"[DB ERROR] update_participant_status: {e}")
            return False

    @database_sync_to_async
    def update_room_participant_count(self, room_code, delta):
        try:
            room = Room.objects.get(room_code=room_code)
            room.current_participants = max(0, room.current_participants + delta)
            room.save()
            return True
        except Exception as e:
            logger.error(f"[DB ERROR] update_room_participant_count: {e}")
            return False

    @database_sync_to_async
    def save_chat_message(self, room_code, username, message_text, is_private=False, recipient=None):
        try:
            room = Room.objects.get(room_code=room_code)
            sender = Participant.objects.get(room=room, username=username)

            recipient_obj = None
            if recipient:
                recipient_obj = Participant.objects.filter(room=room, username=recipient).first()

            chat_message = ChatMessage.objects.create(
                room=room,
                sender=sender,
                recipient=recipient_obj,
                message=message_text,
                is_private=is_private
            )

            logger.info(f"[DB] Mensaje guardado ID: {chat_message.id} de {username}")
            return chat_message

        except Room.DoesNotExist:
            logger.error(f"[DB ERROR] Sala {room_code} no existe")
            return None
        except Participant.DoesNotExist:
            logger.error(f"[DB ERROR] Participante {username} no existe")
            return None
        except Exception as e:
            logger.error(f"[DB ERROR] save_chat_message: {e}")
            return None