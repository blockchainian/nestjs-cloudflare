import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';

import { CHAT_PATH } from './chat.constants.js';

@WebSocketGateway({ path: CHAT_PATH })
export class ChatGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown): unknown {
    return data;
  }
}
