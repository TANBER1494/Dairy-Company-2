const Product = require('../models/Product');
const SupplierTransaction = require('../models/SupplierTransaction');
const ClientTransaction = require('../models/ClientTransaction');
const AppError = require('../utils/AppError');

class ProductService {
  async createProduct(data) {
    const existingProduct = await Product.findOne({ code: data.code, deleted_at: null });
    if (existingProduct) {
      throw new AppError('كود المنتج مسجل بالفعل', 400);
    }
    
    const { current_stock, deleted_at, ...productData } = data;
    return await Product.create(productData);
  }

  async getAllProducts(query = {}) {
    query.deleted_at = null;
    return await Product.find(query).sort({ code: 1 }).lean();
  }

  async getProductById(id) {
    const product = await Product.findOne({ _id: id, deleted_at: null }).lean();
    if (!product) {
      throw new AppError('المنتج غير موجود', 404);
    }
    return product;
  }

  async updateProduct(id, data) {
    if (data.code) {
      const existingProduct = await Product.findOne({ code: data.code, _id: { $ne: id }, deleted_at: null });
      if (existingProduct) {
        throw new AppError('كود المنتج مستخدم لمنتج آخر', 400);
      }
    }

    const { current_stock, is_active, deleted_at, ...productData } = data;

    const product = await Product.findOneAndUpdate({ _id: id, deleted_at: null }, productData, {
      new: true,
      runValidators: true,
    });

    if (!product) {
      throw new AppError('المنتج غير موجود', 404);
    }
    return product;
  }

  async toggleProductStatus(id) {
    const product = await Product.findOne({ _id: id, deleted_at: null });
    if (!product) {
      throw new AppError('المنتج غير موجود', 404);
    }
    product.is_active = !product.is_active;
    await product.save();
    return product;
  }

  async deleteProduct(id) {
    const product = await Product.findOne({ _id: id, deleted_at: null });
    if (!product) {
      throw new AppError('المنتج غير موجود', 404);
    }

    const supplierTxCount = await SupplierTransaction.countDocuments({ product_id: id });
    const clientTxCount = await ClientTransaction.countDocuments({ product_id: id });

    if (supplierTxCount > 0 || clientTxCount > 0) {
      product.deleted_at = new Date();
      product.is_active = false;
      await product.save();
      return { 
        type: 'soft', 
        message: 'تم حذف المنتج مرنياً (إخفاؤه) لوجود فواتير ومبيعات سابقة مرتبطة به.' 
      };
    } else {
      await Product.findByIdAndDelete(id);
      return { 
        type: 'hard', 
        message: 'تم حذف المنتج نهائياً من قاعدة البيانات لعدم ارتباطه بأي فواتير.' 
      };
    }
  }
}

module.exports = new ProductService();