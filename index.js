const { App, LogLevel, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { Configuration, OpenAIApi } = require("openai");
require('dotenv').config();

const userDatabase = {
  userId: '',
}

const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const expressReceiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Add other options if needed
});

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  receiver: expressReceiver,
  logLevel: LogLevel.DEBUG,
});

async function getBotDmChannelId(botUserId) {
  try {
    const result = await webClient.conversations.open({
      users: botUserId,
    });
    return result.channel.id;
  } catch (error) {
    console.error('Error fetching bot DM channel ID:', error);
    return null;
  }
}

async function loadMessages() {
  const channelsResponse = await webClient.conversations.list({
    token: process.env.SLACK_BOT_TOKEN,
    exclude_archived: true
  });

  const botMemberChannels = channelsResponse.channels.filter(channel => channel.is_member);

  const channelSummaries = [];

  for (const channel of botMemberChannels) {
    const channelId = channel.id;
    const startTime = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000); // 24 hours ago
    const endTime = Math.floor(Date.now() / 1000);

    let result;
    let messages = [];

    try {
      result = await webClient.conversations.history({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        oldest: startTime,
        latest: endTime,
        limit: 100
      });

      messages = result.messages;
    } catch (error) {
      console.error(`Error retrieving messages: ${error}`);
      continue;
    }

    let channelMessages = [];

    for (const message of messages) {
      if ('subtype' in message || 'bot_id' in message) continue;

      const speakerName = await getUserName(message.user);
      const formattedText = await replaceUserIdWithName(message.text);
      if (formattedText.includes('@i_summarize summarize')) continue;

      channelMessages.push(`timestamp: ${message.ts} :- ${speakerName} said: ${formattedText}`);

      // Fetch threaded messages
      if (message.reply_count && message.reply_count > 0) {
        const threadResult = await webClient.conversations.replies({
          token: process.env.SLACK_BOT_TOKEN,
          channel: channelId,
          ts: message.ts,
        });

        const threadMessages = threadResult.messages.filter(
          (threadMessage) => !threadMessage.subtype && !threadMessage.bot_id
        );

        for (const threadMessage of threadMessages) {
          const threadSpeakerName = await getUserName(threadMessage.user);
          const threadFormattedText = await replaceUserIdWithName(threadMessage.text);

          channelMessages.push(`${threadSpeakerName} (thread) said: ${threadFormattedText}`);
        }
      }
      console.log('channelMessages --------->', message)
    }

    channelSummaries.push({ channelId, messages: channelMessages});
  }

  return channelSummaries;
}

async function generateChannelSummaries() {
  const channelMessagesArray = await loadMessages();
  const channelSummaries = {};

  for (const { channelId, messages } of channelMessagesArray) {

    if (messages.length > 0) {
      const messageArray = []
      const timestampArray = []
      messages.map((message) => {
        if (!message.includes('timestamp:')) {
          messageArray.push(message);
          return {};
        }
        const timestamp = message.split(':-')[0].split('timestamp:')[1].trim();
        const text = message.split(':-')[1].trim();
        messageArray.push(text);
        timestampArray.push(timestamp);
        return {}
      });
      const messageTexts = messageArray.join(" ").replace('\n', ' ');
      const prompt = `Please provide a summary with separate topics and summaries for the following Slack channel conversations and their threads with reference to users. The main conversation and threads are separated by "(thread)". Format the output as:\n\nTopic 1\n  Summary 1\n\n  Topic 2\n  Summary 2\n\n${messageTexts}`;

      const topicsAndSummaries = await getChatGPTSummary(prompt);
      const formattedTopicsAndSummaries = topicsAndSummaries.split('\n\n').map((item, index) => {
        const lines = item.split('\n');
        const topic = lines[0]?.replace(/Topic(\s\d)?:/, '').trim();
        const summary = lines[1]?.replace(/Summary(\s\d)?:/, '').trim();
        const conversationTimestamp = timestampArray[index];
        const link = `https://isummarize.slack.com/archives/${channelId}/p${conversationTimestamp?.replace('.', '')}`;
        return `><${link}|${topic}>\n>${summary}\n`;
      }).join('\n');

      channelSummaries[channelId] = formattedTopicsAndSummaries;
    } else {
      channelSummaries[channelId] = "There weren't any meaningful conversations in the last 24 hours.";
    }
  }

  return channelSummaries
}

async function getChannelName(channelId) {
  try {
    const result = await app.client.conversations.info({
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
    });

    return result.channel.name;
  } catch (error) {
    console.error(`Error fetching channel name for ${channelId}:`, error);
    return 'unknown';
  }
}

const userCache = new Map();

async function getUserName(userId) {
  if (userCache.has(userId)) {
    return userCache.get(userId);
  }

  try {
    const response = await webClient.users.info({ user: userId });
    // console.log('response --------->', response.user)
    const userProfile = response.user.profile
    const userName = userProfile.display_name || userProfile.real_name || response.user.name;
    userCache.set(userId, userName);
    return userName;
  } catch (error) {
    console.error(`Error getting user name: ${error}`);
    return null;
  }
}

async function replaceUserIdWithName(text) {
  const regex = /<@([A-Z0-9]+)>/g;
  const matches = text.match(regex);

  if (!matches) {
    return text;
  }

  for (const match of matches) {
    const userId = match.slice(2, -1);
    const userName = await getUserName(userId);
    if (userName) {
      text = text.replace(match, `@${userName}`);
    }
  }

  return text;
}

async function getBotDmChannelId(userId) {
  try {
    const result = await app.client.conversations.open({
      token: process.env.SLACK_BOT_TOKEN,
      users: userId,
    });

    return result.channel.id;
  } catch (error) {
    console.error("Error fetching user DM channel ID:", error);
    throw error;
  }
}

app.event('app_mention', async ({ event, say }) => {
  if (event.text.includes("summarize")) {
    
    try {
      handleCustomAppMentionEvent(event.user);
    } catch (error) {
      console.error("Error fetching messages or summarizing:", error);
      await say("An error occurred while fetching messages or generating the summary. Please try again later.");
    }
  }
});

app.event('app_home_opened', async ({ event, context }) => {
  const userId = event.user;
  userDatabase['userId'] = userId;
  console.log(`User who installed the app: ${userId}`);

  createHomeUi();
});

async function createHomeUi() {
  const result = await app.client.views.publish({
    token: process.env.SLACK_BOT_TOKEN,
    user_id: userDatabase['userId'],
    view: {
      type: 'home',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*iSummarize*'  
          },
          accessory: {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Manage App Settings',
              emoji: true
            },
            value: 'settings'
          }
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':slack: Slack Summary\nYour Slack summary has been successfully configured.\nYou will receive the summary daily at 9:00 AM, and it will be accessible in your <https://app.slack.com/client/T054NQJ6XSM/D054NRTT61F|Messages> tab.'
          }
        }
      ]
    }
  });
  console.log('result --------->', result)
}

// Command listener example

async function handleCustomAppMentionEvent(userId = userDatabase['userId']) {
  try {
    
    const channelId = await getBotDmChannelId(userId);
    const channelSummaries = await generateChannelSummaries();
    let formattedSummaries = '';
    for (const [channelId, summaries] of Object.entries(channelSummaries)) {
      const channelName = await getChannelName(channelId);
      const link = `https://isummarize.slack.com/archives/${channelId}`;
      
      formattedSummaries += `<${link}|#${channelName}> \n${summaries}\n\n`;
    }

    sendSummaryToChannel(channelId, formattedSummaries);
  } catch (error) {
    console.error("Error fetching messages or summarizing:", error);
  }
}

app.command('/summarize', async ({ command, ack, respond }) => {
  await ack();
  await respond(`You've entered: ${command.text}`);
});


// Action listener example
app.action('my_button_click', async ({ ack, body, context }) => {
  await ack();
  try {
    await app.webClient.chat.postMessage({
      token: context.botToken,
      channel: body.channel.id,
      text: 'Button clicked!',
    });
  } catch (error) {
    console.error(error);
  }
});

async function sendSummaryToChannel(channelId, summary) {
  try {
    await webClient.chat.postMessage({
      channel: channelId,
      text: `*Good morning, this is your daily summary:* \n\n${summary}`,
    });

    console.log('Summary message sent successfully');
  } catch (error) {
    console.error('Error sending summary message:', error);
  }
}

const twoMinutes = 1000 * 60 * 2;
setInterval(() => {
  if (userDatabase['userId'].length > 0) {
    handleCustomAppMentionEvent();
  } else {
    console.log('No user ID yet: ' + userDatabase['userId'].length);
  }
}, 20000);

async function getChatGPTSummary(text) {
  const response = await openai.createCompletion({
    model: "text-davinci-003",
    // prompt: `Summarize with reference to users '${text}'`,
    prompt: text,
    temperature: 0.7,
    max_tokens: 2048,
    top_p: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 0.0,
  });

  return response.data.choices[0].text.trim();
}

expressReceiver.router.get('/_next/webpack-hmr', (req, res) => {
  res.status(404).send('Not Found');
});

expressReceiver.router.post('/summarize', async (req, res) => {
  // Process the request and generate a response
  // const responseText = `You've entered: ${command.text} `;
  const responseText = `Received POST request with data: ${JSON.stringify(req.body)}`;
  console.log('responseText', responseText)
  res.send(responseText);
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Bolt app is running!');
})();
