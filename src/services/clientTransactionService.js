const mongoose = require('mongoose');
const ClientTransaction = require('../models/ClientTransaction');
const Client = require('../models/Client');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');
const { getCurrentShift } = require('../utils/timeUtils');

class ClientTransactionService {
  async createTransaction(data, userId) {
    const { client_id, worker_id, product_id, quantity, unit_price, paid_amount, shift, notes, date } = data;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const client = await Client.findById(client_id).session(session);
        if (!client) throw new AppError('العميل غير موجود', 404);

        const qty = Number(quantity) || 0;
        const price = Number(unit_price) || 0;
        const paid = Number(paid_amount) || 0;
        const total_price = qty * price;

        if (qty > 0 && product_id) {
          const product = await Product.findOneAndUpdate(
            { _id: product_id, current_stock: { $gte: qty } },
            { $inc: { current_stock: -qty } },
            { new: true, session }
          );

          if (!product) {
            throw new AppError(`عفواً، رصيد المخزن لا يكفي أو المنتج غير موجود. الكمية المطلوبة: ${qty}`, 400);
          }
        }

        const autoShift = getCurrentShift();
        const finalShift = shift || autoShift;

        const transaction = await ClientTransaction.create([{
          client_id,
          worker_id: worker_id || null,
          product_id: product_id || null,
          quantity: qty,
          unit_price: price,
          total_price,
          paid_amount: paid,
          balance_after: client.current_balance,
          shift: finalShift,
          notes,
          date: date || Date.now(),
          created_by: userId
        }], { session });

        await session.commitTransaction();
        return transaction[0];
      } catch (error) {
        await session.abortTransaction();
        
        if (error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError') && attempt < MAX_RETRIES) {
          console.warn(`⚠️ Write conflict detected on POST Client Transaction. Retrying attempt ${attempt}...`);
          continue; 
        }
        
        throw error;
      } finally {
        session.endSession();
      }
    }
  }

  async getAllTransactions(query = {}, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const [transactions, totalItems] = await Promise.all([
      ClientTransaction.find(query)
        .populate('client_id', 'name code')
        .populate('worker_id', 'name')
        .populate('product_id', 'name')
        .populate('created_by', 'name')
        .populate('updated_by', 'name') 
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ClientTransaction.countDocuments(query)
    ]);

    return {
      transactions,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalItems / limit),
        totalItems,
        limit
      }
    };
  }

  async updateTransaction(id, data, userId) {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const oldTx = await ClientTransaction.findById(id).session(session);
        if (!oldTx) throw new AppError('الفاتورة غير موجودة', 404);
        if (oldTx.is_settled) throw new AppError('لا يمكن تعديل فاتورة تم تصفية حسابها', 400);

        const newProductId = data.product_id !== undefined ? data.product_id : oldTx.product_id;
        const qty = data.quantity !== undefined ? Number(data.quantity) : oldTx.quantity;
        const price = data.unit_price !== undefined ? Number(data.unit_price) : oldTx.unit_price;
        const paid = data.paid_amount !== undefined ? Number(data.paid_amount) : oldTx.paid_amount;
        const total_price = qty * price;

        if (oldTx.product_id && oldTx.quantity > 0) {
          await Product.findByIdAndUpdate(
            oldTx.product_id, 
            { $inc: { current_stock: oldTx.quantity } }, 
            { session, new: true }
          );
        }

        if (qty > 0 && newProductId) {
          const product = await Product.findOneAndUpdate(
            { _id: newProductId, current_stock: { $gte: qty } },
            { $inc: { current_stock: -qty } },
            { session, new: true }
          );

          if (!product) {
            throw new AppError(`عفواً، رصيد المخزن لا يكفي لتعديل الفاتورة.`, 400);
          }
        }

        const updatedTx = await ClientTransaction.findByIdAndUpdate(id, {
          ...data,
          total_price,
          updated_by: userId
        }, { new: true, runValidators: true, session });

        await session.commitTransaction();
        return updatedTx;
      } catch (error) {
        await session.abortTransaction();
        
        if (error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError') && attempt < MAX_RETRIES) {
          continue;
        }
        
        throw error;
      } finally {
        session.endSession();
      }
    }
  }

  async deleteTransaction(id) {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const tx = await ClientTransaction.findById(id).session(session);
        if (!tx) throw new AppError('الفاتورة غير موجودة', 404);
        if (tx.is_settled) throw new AppError('لا يمكن حذف فاتورة تم تصفية حسابها', 400);

        if (tx.product_id && tx.quantity > 0) {
          await Product.findByIdAndUpdate(
            tx.product_id, 
            { $inc: { current_stock: tx.quantity } }, 
            { session, new: true }
          );
        }

        await tx.deleteOne({ session });
        
        await session.commitTransaction();
        return true;
      } catch (error) {
        await session.abortTransaction();
        
        if (error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError') && attempt < MAX_RETRIES) {
          continue;
        }
        
        throw error;
      } finally {
        session.endSession();
      }
    }
  }

  async bulkCreateTransactions(transactionsData, userId) {
    const results = [];
    for (const data of transactionsData) {
      const tx = await this.createTransaction(data, userId);
      results.push(tx);
    }
    return results;
  }
}

module.exports = new ClientTransactionService();