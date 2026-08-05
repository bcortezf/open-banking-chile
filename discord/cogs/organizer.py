"""
Cog de organización del servidor open-banking-chile.
"""

import discord
from discord.ext import commands
from discord import app_commands


class Organizer(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="canales", description="Muestra la estructura de canales del servidor")
    async def canales(self, interaction: discord.Interaction):
        embed = discord.Embed(title="📋 Estructura del servidor", color=discord.Color.blue())
        for category in interaction.guild.categories:
            channels = "\n".join(f"  {ch.mention}" for ch in category.channels) if category.channels else "  *(vacío)*"
            embed.add_field(name=f"📁 {category.name}", value=channels, inline=False)
        uncategorized = [ch for ch in interaction.guild.channels if ch.category is None]
        if uncategorized:
            embed.add_field(name="📁 Sin categoría", value="\n".join(f"  {ch.mention}" for ch in uncategorized), inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="roles", description="Muestra los roles del servidor")
    async def roles(self, interaction: discord.Interaction):
        roles = sorted(interaction.guild.roles, key=lambda r: r.position, reverse=True)
        roles = [r for r in roles if r.name != "@everyone"]
        embed = discord.Embed(title="🎭 Roles del servidor", color=discord.Color.blue())
        for role in roles[:20]:
            members = len([m for m in interaction.guild.members if role in m.roles])
            embed.add_field(name=f"{role.mention}", value=f"`{members}` miembros", inline=True)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="canal-crear", description="Crea un canal de texto")
    @app_commands.default_permissions(manage_channels=True)
    async def canal_crear(self, interaction: discord.Interaction, nombre: str, categoria: str = None):
        guild = interaction.guild
        category = None
        if categoria:
            category = discord.utils.get(guild.categories, name=categoria)
            if not category:
                category = await guild.create_category(categoria)
        channel = await guild.create_text_channel(nombre, category=category, topic=f"Canal: {nombre}")
        await interaction.response.send_message(f"✅ Canal {channel.mention} creado.")

    @app_commands.command(name="canal-archivar", description="Archiva un canal")
    @app_commands.default_permissions(manage_channels=True)
    async def canal_archivar(self, interaction: discord.Interaction, canal: discord.TextChannel):
        guild = interaction.guild
        archive = discord.utils.get(guild.categories, name="Archivo")
        if not archive:
            archive = await guild.create_category("Archivo", position=0)
        await canal.edit(category=archive, sync_permissions=True)
        await interaction.response.send_message(f"📦 {canal.mention} archivado.", ephemeral=True)

    @app_commands.command(name="setup", description="Crea la estructura base del servidor")
    @app_commands.default_permissions(administrator=True)
    async def setup(self, interaction: discord.Interaction):
        guild = interaction.guild
        await interaction.response.defer(ephemeral=True)

        estructura = {
            "📢 Información": [
                ("bienvenida", "👋 Bienvenida e info del proyecto"),
                ("anuncios", "📢 Anuncios del equipo"),
                ("normas", "📜 Reglas del servidor"),
            ],
            "💬 General": [
                ("general", "💬 Charla general"),
                ("ayuda", "❓ Ayuda con scrapers"),
                ("ideas", "💡 Sugerencias"),
            ],
            "🏦 Bancos": [
                ("banco-chile", "Banco de Chile"),
                ("falabella", "Banco Falabella + CMR"),
                ("santander", "Banco Santander"),
                ("bci", "BCI"),
                ("banco-estado", "Banco Estado"),
                ("scotiabank", "Scotiabank"),
                ("itau", "Itaú"),
                ("edwards", "Banco Edwards"),
                ("bice", "Banco BICE"),
                ("cencosud", "Tarjeta Cencosud"),
                ("bancosecurity", "Banco Security"),
            ],
            "🛠️ Desarrollo": [
                ("pull-requests", "📥 PRs abiertos"),
                ("issues", "🐛 Bugs"),
                ("testing", "🧪 Pruebas"),
            ],
            "📦 Archivo": [],
        }

        creados = 0
        for cat_name, canales in estructura.items():
            category = discord.utils.get(guild.categories, name=cat_name)
            if not category:
                category = await guild.create_category(cat_name)
                creados += 1
            for ch_name, ch_topic in canales:
                existing = discord.utils.get(category.channels, name=ch_name)
                if not existing:
                    await guild.create_text_channel(ch_name, category=category, topic=ch_topic)
                    creados += 1

        await interaction.followup.send(f"✅ Estructura lista. {creados} canales/categorías nuevos.", ephemeral=True)

    @commands.command(name="limpiar", help="Elimina N mensajes (default: 10)")
    @commands.has_permissions(manage_messages=True)
    async def limpiar(self, ctx: commands.Context, cantidad: int = 10):
        if cantidad < 1 or cantidad > 100:
            await ctx.send("❌ Entre 1 y 100.")
            return
        deleted = await ctx.channel.purge(limit=cantidad + 1)
        msg = await ctx.send(f"🧹 {len(deleted) - 1} eliminados.")
        await msg.delete(delay=3)

    @commands.command(name="info", help="Info del proyecto")
    async def info(self, ctx: commands.Context):
        embed = discord.Embed(
            title="🏦 open-banking-chile",
            description="Scrapers open source para bancos chilenos.\nExtrae movimientos y saldos como JSON — 100% local.",
            color=discord.Color.blue(),
            url="https://github.com/bcortezf/open-banking-chile",
        )
        embed.add_field(name="🌐 Bancos", value="11 soportados", inline=True)
        embed.add_field(name="📦 Stack", value="TypeScript + Puppeteer", inline=True)
        embed.add_field(name="📄 Licencia", value="MIT", inline=True)
        embed.set_footer(text="Fork comunitario • Hecho en Chile 🇨🇱")
        await ctx.send(embed=embed)


async def setup(bot: commands.Bot):
    await bot.add_cog(Organizer(bot))
