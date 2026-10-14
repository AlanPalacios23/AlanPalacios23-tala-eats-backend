import os
from sqlalchemy import select
from .db import SessionLocal
from .models import User
from .security import hash_password

email=os.getenv('BOOTSTRAP_ADMIN_EMAIL','').strip().lower()
password=os.getenv('BOOTSTRAP_ADMIN_PASSWORD','').strip()
name=os.getenv('BOOTSTRAP_ADMIN_NAME','Tala Eats Admin').strip()
if email and password:
    if len(password)<12:
        raise SystemExit('BOOTSTRAP_ADMIN_PASSWORD debe tener al menos 12 caracteres')
    with SessionLocal() as db:
        user=db.scalar(select(User).where(User.email==email))
        if not user:
            user=User(name=name,email=email,password_hash=hash_password(password),role='admin',auth_provider='local',is_active=True)
            db.add(user);db.commit();print(f'[Tala Eats] Admin inicial creado: {email}')
        elif user.role!='admin':
            user.role='admin';user.is_active=True;db.commit();print(f'[Tala Eats] Usuario promovido a admin: {email}')
        else:
            print(f'[Tala Eats] Admin ya existe: {email}')
else:
    print('[Tala Eats] Bootstrap admin omitido (variables no configuradas).')
