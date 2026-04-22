require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
  .setName('mycodes')
  .setDescription('View your recent purchased codes'),

  new SlashCommandBuilder()
  .setName('resendcode')
  .setDescription('Re-send your latest purchased code'),
  
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is online'),

  new SlashCommandBuilder()
    .setName('points')
    .setDescription('View your points'),

  new SlashCommandBuilder()
  .setName('checkcodes')
  .setDescription('Admin: check a user purchase history')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('Target user')
      .setRequired(true)
  ),
  
  new SlashCommandBuilder()
    .setName('addpoints')
    .setDescription('Admin: add points to a user')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Target user')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('amount')
        .setDescription('How many points to add')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('View shop items'),

  new SlashCommandBuilder()
    .setName('addcode')
    .setDescription('Admin: add a redemption code to stock')
    .addIntegerOption(option =>
      option
        .setName('product_id')
        .setDescription('Product ID')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('code')
        .setDescription('Redemption code')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('deletecode')
    .setDescription('Admin: delete a redemption code')
    .addIntegerOption(option =>
      option
        .setName('code_id')
        .setDescription('Redemption code ID')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Purchase an item')
    .addIntegerOption(option =>
      option
        .setName('product_id')
        .setDescription('Product ID')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('codes')
    .setDescription('View stock for a specific product')
    .addIntegerOption(option =>
      option
        .setName('product_id')
        .setDescription('Product ID')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('View stock for all products'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the invite leaderboard'),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Send the leaderboard and points button panel'),

  new SlashCommandBuilder()
    .setName('partner')
    .setDescription('Post a Roblox invite message')
    .addStringOption(option =>
      option
        .setName('game_link')
        .setDescription('Your Roblox game link')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('profile_link')
        .setDescription('Your Roblox profile link')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('note')
        .setDescription('Optional short note')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('partnerpanel')
    .setDescription('Send the teammate finder button panel'),

  new SlashCommandBuilder()
    .setName('securitylogs')
    .setDescription('View recent security logs')
    .addIntegerOption(option =>
      option
        .setName('limit')
        .setDescription('Number of logs to show (default 10, max 20)')
        .setRequired(false)
    )
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('Filter logs by user')
      .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('securitystatus')
    .setDescription('View the security system status'),

  new SlashCommandBuilder()
    .setName('lockshop')
    .setDescription('Admin: lock the shop')
    .addStringOption(option =>
      option
        .setName('reason')
        .setDescription('Lock reason')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('unlockshop')
    .setDescription('Admin: unlock the shop'),

  new SlashCommandBuilder()
  .setName('securityreset')
  .setDescription('Admin: reset a user security status')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('Target user')
      .setRequired(true)
  )
.addStringOption(option =>
  option
    .setName('reason')
    .setDescription('Reason for reset')
    .setRequired(false)
),

  new SlashCommandBuilder()
    .setName('securitypanel')
    .setDescription('Send the security control panel'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering commands...');

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log('✅ Commands registered successfully');
  } catch (error) {
    console.error(error);
  }
})();