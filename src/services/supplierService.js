const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const AppError = require('../utils/AppError');
const SupplierTransaction = require('../models/SupplierTransaction');
const { getCurrentShift } = require('../utils/timeUtils');

class SupplierService {
  async createSupplier(data) {
    const existingSupplier = await Supplier.findOne({ code: data.code });
    if (existingSupplier) {
      throw new AppError('كود المورد مسجل بالفعل', 400);
    }
    
    const { current_balance, ...supplierData } = data;
    supplierData.current_balance = 0; 
    return await Supplier.create(supplierData);
  }

  async getAllSuppliers(query = {}) {
    const filter = {};
    if (query.active !== undefined) {
      filter.is_active = query.active === 'true';
    }
    if (query.address) {
      filter.address = { $regex: query.address, $options: 'i' };
    }
    return await Supplier.find(filter).sort({ code: 1 }).lean();
  }

  async getSupplierById(id) {
    const supplier = await Supplier.findById(id).lean();
    if (!supplier) throw new AppError('المورد غير موجود', 404);
    return supplier;
  }

  async updateSupplier(id, data) {
    if (data.code) {
      const existingSupplier = await Supplier.findOne({ code: data.code, _id: { $ne: id } });
      if (existingSupplier) throw new AppError('كود المورد مستخدم لمورد آخر', 400);
    }
    
    const { current_balance, ...supplierData } = data;
    const supplier = await Supplier.findByIdAndUpdate(id, supplierData, { new: true, runValidators: true });
    if (!supplier) throw new AppError('المورد غير موجود', 404);
    return supplier;
  }

  async toggleSupplierStatus(id) {
    const supplier = await Supplier.findById(id);
    if (!supplier) throw new AppError('المورد غير موجود', 404);
    supplier.is_active = !supplier.is_active;
    await supplier.save();
    return supplier;
  }

  async getSupplierStatement(searchKey, page = 1, limit = 50) {
    let query = {};
    if (!isNaN(searchKey)) {
      query.code = Number(searchKey);
    } else {
      query.name = { $regex: searchKey, $options: 'i' };
    }
    const supplier = await Supplier.findOne(query).lean();
    if (!supplier) throw new AppError('المورد غير موجود بهذا الكود أو الاسم', 404);

    const skip = (page - 1) * limit;
    
    const [transactions, totalItems] = await Promise.all([
      SupplierTransaction.find({ supplier_id: supplier._id })
        .populate('worker_id', 'name')
        .populate('product_id', 'name')
        .populate('created_by', 'name')
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupplierTransaction.countDocuments({ supplier_id: supplier._id })
    ]);

    return { 
      supplier_info: supplier, 
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
      const supplier = await Supplier.findById(id).session(session);
      if (!supplier) throw new AppError('المورد غير موجود', 404);

      const unsettledTxs = await SupplierTransaction.find({ supplier_id: id, is_settled: false }).select('_id').session(session);
      const unsettledIds = unsettledTxs.map(tx => tx._id);

      const totalAmountFromFrontend = Number(payload.total_amount) || 0; 
      const paidNow = Number(payload.paid_amount) || 0; 

      let missingMilkValue = totalAmountFromFrontend - supplier.current_balance;
      if (missingMilkValue < 0) missingMilkValue = 0; 

      supplier.current_balance = totalAmountFromFrontend - paidNow;
      await supplier.save({ session });

      if (unsettledIds.length > 0) {
        await SupplierTransaction.updateMany(
          { _id: { $in: unsettledIds } },
          { $set: { is_settled: true } },
          { session }
        );
      }

      const currentShift = getCurrentShift();

      await SupplierTransaction.create([{
        supplier_id: id,
        quantity: 0, 
        unit_price: 0,
        total_price: missingMilkValue, 
        paid_amount: paidNow,          
        shift: currentShift,
        balance_after: supplier.current_balance,
        is_settled: true,   
        notes: "تسوية وقفل دفتر",
        created_by: userId
      }], { session });

      await session.commitTransaction();
      return supplier;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }
}

module.exports = new SupplierService();