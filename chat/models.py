from django.db import models

# Create your models here.

class Room(models.Model):
    """Modelo para las salas de videochat"""
    room_code = models.CharField(max_length=20, unique=True)
    admin_username = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)
    current_participants = models.IntegerField(default=0)
    
    def __str__(self):
        return f"Sala {self.room_code} - Admin: {self.admin_username}"


class Participant(models.Model):
    """Modelo para los participantes de las salas"""
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='participants')
    username = models.CharField(max_length=100)
    joined_at = models.DateTimeField(auto_now_add=True)
    left_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    is_screen_sharing = models.BooleanField(default=False)
    
    def __str__(self):
        return f"{self.username} en {self.room.room_code}"


class ScreenShareHistory(models.Model):
    """Historial de screen sharing"""
    room = models.ForeignKey(Room, on_delete=models.CASCADE)
    participant = models.ForeignKey(Participant, on_delete=models.CASCADE)
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_seconds = models.IntegerField(default=0)
    
    def __str__(self):
        return f"Screen share de {self.participant.username} en {self.room.room_code}"


class ChatMessage(models.Model):
    """Guardar mensajes del chat"""
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(Participant, on_delete=models.CASCADE, related_name='messages')
    recipient = models.ForeignKey(Participant, on_delete=models.CASCADE, null=True, blank=True, related_name='received_messages')
    message = models.TextField()
    is_private = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    
    def __str__(self):
        return f"{self.sender.username}: {self.message[:30]}..."


class ReactionLog(models.Model):
    """Registro de reacciones"""
    room = models.ForeignKey(Room, on_delete=models.CASCADE)
    participant = models.ForeignKey(Participant, on_delete=models.CASCADE)
    emoji = models.CharField(max_length=10)
    created_at = models.DateTimeField(auto_now_add=True)
    
    def __str__(self):
        return f"{self.participant.username} -> {self.emoji}"