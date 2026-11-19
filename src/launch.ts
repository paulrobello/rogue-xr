import { failLoading } from './ui/loading-screen.ts';

void import('./main.ts').catch(failLoading);
