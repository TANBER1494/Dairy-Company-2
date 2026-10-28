const mongoose = require('mongoose');
const Client = require('../models/Client');
const AppError = require('../utils/AppError');
const ClientTransaction = require('../models/ClientTransaction');
const { getCurrentShift } = require('../utils/timeUtils');

class ClientService {
  async createClient(data) {
    const existingClient = await Client.findOne({ code: data.code });
    if (existingClient) throw new AppError('كود العميل مسجل بالفعل', 400);
    
    const { current_balance, ...clientData } = data;
    clientData.current_balance = 0; 
    return await Client.create(clientData);
  }

  async getAllClients(query = {}) {
    const filter = {};
    if (query.active !== undefined) {
      filter.is_active = query.active === 'true';
    }
    if (query.address) {
      filter.address = { $regex: query.address, $options: 'i' };
    }
    return await Client.find(filter).sort({ code: 1 }).lean();
  }

  async getClientById(id) {
    const client = await Client.findById(id).lean();
    if (!client) throw new AppError('العميل غير موجود', 404);
    return client;
  }

  async updateClient(id, data) {
    if (data.code) {
      const existingClient = await Client.findOne({ code: data.code, _id: { $ne: id } });
      if (existingClient) throw new AppError('كود العميل مستخدم لعميل آخر', 400);
    }
    
    const { current_balance, ...clientData } = data;
    const client = await Client.findByIdAndUpdate(id, clientData, { new: true, runValidators: true });
    if (!client) throw new AppError('العميل غير موجود', 404);
    return client;
  }

  async toggleClientStatus(id) {
    const client = await Client.findById(id);
    if (!client) throw new AppError('العميل غير موجود', 404);
    client.is_active = !client.is_active;
    await client.save();
    return client;
  }

  async getClientStatement(searchKey, page = 1, limit = 50) {
    let query = {};
    if (!isNaN(searchKey)) {
      query.code = Number(searchKey);
    } else {
      query.name = { $regex: searchKey, $options: 'i' };
    }
    const client = await Client.findOne(query).lean();
    if (!client) throw new AppError('العميل غير موجود بهذا الكود أو الاسم', 404);

    const skip = (page - 1) * limit;

    const [transactions, totalItems] = await Promise.all([
      ClientTransaction.find({ client_id: client._id })
        .populate('worker_id', 'name')
        .populate('product_id', 'name')
        .populate('created_by', 'name')
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ClientTransaction.countDocuments({ client_id: client._id })
    ]);

    return { 
      client_info: client, 
      transactions_history: transactions,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalItems / limit),
        totalItems,
        limit
      }
    };
  }

  async settleAccount(id, payload, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const client = await Client.findById(id).session(session);
      if (!client) throw new AppError('العميل غير موجود', 404);

      const unsettledTxs = await ClientTransaction.find({ client_id: id, is_settled: false }).select('_id').session(session);
      const unsettledIds = unsettledTxs.map(tx => tx._id);

      const totalAmountFromFrontend = Number(payload.total_amount) || 0; 
      const paidNow = Number(payload.paid_amount) || 0; 

      let missingMilkValue = totalAmountFromFrontend - client.current_balance;
      if (missingMilkValue < 0) missingMilkValue = 0; 

      client.current_balance = totalAmountFromFrontend - paidNow;
      await client.save({ session });

      if (unsettledIds.length > 0) {
        await ClientTransaction.updateMany(
          { _id: { $in: unsettledIds } },
          { $set: { is_settled: true } },
          { session }
        );
      }

      const currentShift = getCurrentShift();

      await ClientTransaction.create([{
        client_id: id,
        quantity: 0,
        unit_price: 0,
        total_price: missingMilkValue, 
        paid_amount: paidNow, 
        shift: currentShift,
        balance_after: client.current_balance,
        is_settled: true,
        notes: "تسوية وقفل دفتر",
        created_by: userId
      }], { session });

      await session.commitTransaction();
      return client;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }
}

module.exports = new ClientService();