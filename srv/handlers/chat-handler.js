'use strict';

const ChatService = require('../lib/ChatService');

async function chat(req) {
    try {
        return await ChatService.chat({
            messages: req.data.messages,
            context: req.data.context
        });
    } catch (err) {
        console.error('[chat-handler]', err.message);
        return ChatService.chatWithError({
            messages: req.data.messages,
            errorMessage: `I could not complete that request: ${err.message}`
        });
    }
}

function register(srv) {
    srv.on('chat', chat);
}

module.exports = { register };
