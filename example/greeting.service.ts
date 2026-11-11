import { Injectable } from '@nestjs/common';

@Injectable()
export class GreetingService {
  greet(): string {
    return 'Hello from Nest';
  }
}
