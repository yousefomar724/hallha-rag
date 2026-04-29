import { MongoClient } from 'mongodb';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let mongoClient: MongoClient | null = null;
let checkpointer: MongoDBSaver | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (!mongoClient) {
    mongoClient = new MongoClient(env.MONGO_URI);
    await mongoClient.connect();
    logger.info('Connected to MongoDB');
  }
  return mongoClient;
}

export async function getCheckpointer(): Promise<MongoDBSaver> {
  if (!checkpointer) {
    const client = await getMongoClient();
    checkpointer = new MongoDBSaver({
      client,
      dbName: env.MONGO_DB_NAME,
      checkpointCollectionName: env.MONGO_CHECKPOINT_COLLECTION,
      checkpointWritesCollectionName: env.MONGO_CHECKPOINT_WRITES_COLLECTION,
    });
  }
  return checkpointer;
}

export async function closeMongo(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    checkpointer = null;
  }
}
