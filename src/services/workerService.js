const Worker = require('../models/Worker');
const SupplierTransaction = require('../models/SupplierTransaction');
const ClientTransaction = require('../models/ClientTransaction');
const AppError = require('../utils/AppError');

class WorkerService {
  async createWorker(data) {
    const { is_active, deleted_at, ...workerData } = data;
    return await Worker.create(workerData);
  }

  async getAllWorkers(query = {}) {
    query.deleted_at = null; 
    return await Worker.find(query).sort({ createdAt: -1 }).lean();
  }

  async getWorkerById(id) {
    const worker = await Worker.findOne({ _id: id, deleted_at: null }).lean();
    if (!worker) throw new AppError('العامل غير موجود', 404);
    return worker;
  }

  async updateWorker(id, data) {
    const { is_active, deleted_at, ...workerData } = data;

    const worker = await Worker.findOneAndUpdate({ _id: id, deleted_at: null }, workerData, { new: true, runValidators: true });
    if (!worker) throw new AppError('العامل غير موجود', 404);
    return worker;
  }

  async toggleWorkerStatus(id) {
    const worker = await Worker.findOne({ _id: id, deleted_at: null });
    if (!worker) throw new AppError('العامل غير موجود', 404);
    worker.is_active = !worker.is_active;
    await worker.save();
    return worker;
  }

  async deleteWorker(id) {
    const worker = await Worker.findOne({ _id: id, deleted_at: null });
    if (!worker) {
      throw new AppError('العامل غير موجود', 404);
    }

    const supplierTxCount = await SupplierTransaction.countDocuments({ worker_id: id });
    const clientTxCount = await ClientTransaction.countDocuments({ worker_id: id });

    if (supplierTxCount > 0 || clientTxCount > 0) {
      worker.deleted_at = new Date();
      worker.is_active = false;
      await worker.save();
      return { 
        type: 'soft', 
        message: 'تم حذف العامل مرنياً (إخفاؤه) لوجود فواتير توريد أو مبيعات سابقة مرتبطة به.' 
      };
    } else {
      await Worker.findByIdAndDelete(id);
      return { 
        type: 'hard', 
        message: 'تم حذف العامل نهائياً من قاعدة البيانات لعدم ارتباطه بأي فواتير.' 
      };
    }
  }
}

module.exports = new WorkerService();