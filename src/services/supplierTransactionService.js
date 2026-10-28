const mongoose = require('mongoose');
const SupplierTransaction = require('../models/SupplierTransaction');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');
const { getCurrentShift } = require('../utils/timeUtils');

class SupplierTransactionService {
  async createTransaction(data, userId) {
    const { supplier_id, worker_id, product_id, quantity, unit_price, paid_amount, shift, notes, date } = data;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const supplier = await Supplier.findById(supplier_id).session(session);
        if (!supplier) throw new AppError('المورد غير موجود', 404);

        const qty = Number(quantity) || 0;
        const price = Number(unit_price) || 0;
        const paid = Number(paid_amount) || 0;
        const total_price = qty * price;

        if (qty > 0 && product_id) {
          await Product.findByIdAndUpdate(
            product_id, 
            { $inc: { current_stock: qty } }, 
            { session, new: true } 
          );
        }

        const autoShift = getCurrentShift();
        const finalShift = shift || autoShift;

        const transaction = await SupplierTransaction.create([{
          supplier_id,
          worker_id: worker_id || null,
          product_id: product_id || null,
          quantity: qty,
          unit_price: price,
          total_price,
          paid_amount: paid,
          balance_after: supplier.current_balance, 
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
          console.warn(`⚠️ Write conflict detected on POST Supplier Transaction. Retrying attempt ${attempt}...`);
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
      SupplierTransaction.find(query)
        .populate('supplier_id', 'name code')
        .populate('worker_id', 'name')
        .populate('product_id', 'name')
        .populate('created_by', 'name')
        .populate('updated_by', 'name') 
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupplierTransaction.countDocuments(query)
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
        const oldTx = await SupplierTransaction.findById(id).session(session);
        if (!oldTx) throw new AppError('الفاتورة غير موجودة', 404);
        if (oldTx.is_settled) throw new AppError('لا يمكن تعديل فاتورة تم تصفية حسابها', 400);

        const newProductId = data.product_id !== undefined ? data.product_id : oldTx.product_id;
        const qty = data.quantity !== undefined ? Number(data.quantity) : oldTx.quantity;
        const price = data.unit_price !== undefined ? Number(data.unit_price) : oldTx.unit_price;
        const paid = data.paid_amount !== undefined ? Number(data.paid_amount) : oldTx.paid_amount;
        const total_price = qty * price;

        if (oldTx.product_id && oldTx.quantity > 0) {
          if (newProductId && newProductId.toString() === oldTx.product_id.toString()) {
            if (qty < oldTx.quantity) {
              const deduction = oldTx.quantity - qty;
              const product = await Product.findOneAndUpdate(
                { _id: oldTx.product_id, current_stock: { $gte: deduction } },
                { $inc: { current_stock: -deduction } },
                { session, new: true }
              );
              if (!product) throw new AppError(`لا يمكن تقليل كمية الفاتورة. تم بيع جزء من هذا التوريد والمخزن لا يكفي.`, 400);
            } else if (qty > oldTx.quantity) {
              const addition = qty - oldTx.quantity;
              await Product.findByIdAndUpdate(oldTx.product_id, { $inc: { current_stock: addition } }, { session, new: true });
            }
          } else {
            const oldProduct = await Product.findOneAndUpdate(
              { _id: oldTx.product_id, current_stock: { $gte: oldTx.quantity } },
              { $inc: { current_stock: -oldTx.quantity } },
              { session, new: true }
            );
            if (!oldProduct) throw new AppError(`لا يمكن تغيير المنتج. تم بيع جزء من التوريد القديم.`, 400);

            if(qty > 0) {
               await Product.findByIdAndUpdate(newProductId, { $inc: { current_stock: qty } }, { session, new: true });
            }
          }
        } else {
          if(qty > 0 && newProductId) {
               await Product.findByIdAndUpdate(newProductId, { $inc: { current_stock: qty } }, { session, new: true });
          }
        }

        const updatedTx = await SupplierTransaction.findByIdAndUpdate(id, {
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
        const tx = await SupplierTransaction.findById(id).session(session);
        if (!tx) throw new AppError('الفاتورة غير موجودة', 404);
        if (tx.is_settled) throw new AppError('لا يمكن حذف فاتورة تم تصفية حسابها', 400);

        if (tx.product_id && tx.quantity > 0) {
          const product = await Product.findOneAndUpdate(
            { _id: tx.product_id, current_stock: { $gte: tx.quantity } },
            { $inc: { current_stock: -tx.quantity } },
            { session, new: true }
          );
          if (!product) throw new AppError(`لا يمكن حذف هذه الفاتورة. تم بيع جزء من التوريد للعملاء، ورصيد المخزن أقل من كمية الفاتورة.`, 400);
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

module.exports = new SupplierTransactionService();