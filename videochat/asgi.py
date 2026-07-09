"""
ASGI config for videochat project.

It exposes the ASGI callable as a module-level variable named `application`.
"""

import os
import django
from django.core.asgi import get_asgi_application

# 1. Configurar la variable de entorno primero
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'videochat.settings')

# 2. Inicializar Django antes de importar cualquier cosa de las apps (como routing o consumers)
django.setup()
django_asgi_app = get_asgi_application()

# 3. AHORA SÍ importamos channels y las rutas de tu app chat
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
import chat.routing

# 4. Definir el enrutador principal usando la app http ya inicializada
application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": AuthMiddlewareStack(
        URLRouter(
            chat.routing.websocket_urlpatterns
        )
    ),
})