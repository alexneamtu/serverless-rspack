import { readFileSync } from 'node:fs';

// Lambda runs handlers with the package root as the working directory.
export const handler = async (): Promise<{ message: string }> => ({
  message: readFileSync('assets/message.txt', 'utf8'),
});
