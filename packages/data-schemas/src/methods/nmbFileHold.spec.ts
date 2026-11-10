import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createNmbFileHoldMethods } from './nmbFileHold';
import nmbFileHoldSchema from '~/schema/nmbFileHold';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createNmbFileHoldMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  if (!mongoose.models.NmbFileHold) {
    mongoose.model('NmbFileHold', nmbFileHoldSchema);
  }
  methods = createNmbFileHoldMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('NmbFileHold methods', () => {
  it("lists only the caller's unreleased holds, newest first, with the file name", async () => {
    await methods.createNmbFileHold({
      userId: 'u1',
      sha256: 'a',
      reviewId: 'rev_000000000001',
      filename: 'old.pdf',
    });
    await methods.createNmbFileHold({
      userId: 'u1',
      sha256: 'b',
      reviewId: 'rev_000000000002',
      filename: 'new.pdf',
    });
    await methods.createNmbFileHold({ userId: 'u2', sha256: 'c', reviewId: 'rev_000000000003' });

    const list = await methods.listNmbFileHolds('u1');
    expect(list.map((h) => h.reviewId)).toEqual(['rev_000000000002', 'rev_000000000001']);
    expect(list[0].filename).toBe('new.pdf');
    expect(await methods.listNmbFileHolds('nobody')).toEqual([]);
  });

  it('stops listing a hold once it has been released by a re-upload', async () => {
    await methods.createNmbFileHold({ userId: 'u1', sha256: 'a', reviewId: 'rev_000000000001' });
    expect(await methods.consumeNmbFileHold('rev_000000000001', 'u1')).toBe(true);
    expect(await methods.listNmbFileHolds('u1')).toEqual([]);
    expect(await methods.consumeNmbFileHold('rev_000000000001', 'u1')).toBe(false);
  });
});
