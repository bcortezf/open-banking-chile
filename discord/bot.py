#!/usr/bin/env python3
"""
Open Banking Chile — Discord Bot
"""

import discord
from discord.ext import commands
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from config import Config

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(
    command_prefix=Config.COMMAND_PREFIX,
    intents=intents,
    application_id=int(Config.APPLICATION_ID),
)


@bot.event
async def on_ready():
    print(f"✅ Bot conectado como {bot.user}")
    print(f"   Servidores: {len(bot.guilds)}")
    for guild in bot.guilds:
        print(f"   - {guild.name} ({guild.id})")
    try:
        synced = await bot.tree.sync()
        print(f"   Comandos slash sincronizados: {len(synced)}")
    except Exception as e:
        print(f"   Error sync: {e}")


@bot.event
async def on_command_error(ctx: commands.Context, error):
    if isinstance(error, commands.CommandNotFound):
        pass
    else:
        await ctx.send(f"❌ Error: {error}")
        raise error


async def load_cogs():
    cogs_dir = pathlib.Path(__file__).parent / "cogs"
    for cog_file in cogs_dir.glob("*.py"):
        if cog_file.name.startswith("_"):
            continue
        await bot.load_extension(f"cogs.{cog_file.stem}")
        print(f"  ✅ Cog: {cog_file.stem}")


async def main():
    Config.validate()
    async with bot:
        await load_cogs()
        await bot.start(Config.BOT_TOKEN)


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
