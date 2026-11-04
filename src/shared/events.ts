export type EventStatus = 'planned' | 'coming-soon';

export interface GameEvent {
  id: string;
  title: string;
  description: string;
  status: EventStatus;
}

export const events: GameEvent[] = [
  {
    id: 'project-war',
    title: 'Project War',
    description: 'Матчевый военный режим',
    status: 'planned',
  },
  {
    id: 'unannounced',
    title: '???',
    description: '',
    status: 'coming-soon',
  },
];
