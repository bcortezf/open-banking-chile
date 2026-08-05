import os
from dotenv import load_dotenv
import pathlib

load_dotenv(pathlib.Path(__file__).parent.parent / ".env")

class Config:
    BOT_TOKEN: str = os.getenv("DISCORD_BOT_TOKEN", "")
    APPLICATION_ID: str = os.getenv("DISCORD_APP_ID", "1530278284292788346")
    PUBLIC_KEY: str = os.getenv("DISCORD_PUBLIC_KEY", "a0755410f6e23804572907f6f5a5f18ed2e8a8dc0215a2225aa6415936bc30dc")
    GUILD_ID: int = int(os.getenv("DISCORD_GUILD_ID", "0"))
    COMMAND_PREFIX: str = "!"

    @classmethod
    def validate(cls):
        if not cls.BOT_TOKEN:
            raise ValueError("DISCORD_BOT_TOKEN no está configurado en .env")
        if not cls.GUILD_ID:
            raise ValueError("DISCORD_GUILD_ID no está configurado en .env")
