from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    re_path(r'^ws/(?P<room_code>[^/]+)/$', consumers.VideoChatConsumer.as_asgi()),
    re_path(r'^ws/$', consumers.VideoChatConsumer.as_asgi()),
]