const DB_NAME = 'OdaGelirTakipDB';
const DB_VERSION = 1;
const STORE_NAMES = {
    TRANSACTIONS: 'transactions',
    UNPAID: 'unpaid',
    PAID: 'paid',
    SETTINGS: 'settings'
};

const STORAGE_LIMITS = {
    MAX_RECORDS: 5000,
    MAX_STORAGE_MB: 5
};

let db;
let currentChart = null;
let paymentRatioChart = null;
let currencyRatioChart = null;
let comparisonChart = null;
let accountingPieChart = null;
let currentDate = new Date();
let selectedCurrencies = ['TL'];
let exchangeRates = {
    USD: 32.45,
    EUR: 35.18,
    GBP: 41.32,
    lastUpdated: null
};
let cachedTransactions = null;

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = (event) => {
            console.error("Veritabanı hatası:", event.target.error);
            showToast('Veritabanı bağlantısı kurulamadı.', 'error');
            reject(event.target.error);
        };
        
        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            if (!db.objectStoreNames.contains(STORE_NAMES.TRANSACTIONS)) {
                const transactionStore = db.createObjectStore(STORE_NAMES.TRANSACTIONS, { keyPath: 'id', autoIncrement: true });
                transactionStore.createIndex('roomNumber', 'roomNumber', { unique: false });
                transactionStore.createIndex('date', 'date', { unique: false });
                transactionStore.createIndex('isPaid', 'isPaid', { unique: false });
            }
            
            if (!db.objectStoreNames.contains(STORE_NAMES.UNPAID)) {
                db.createObjectStore(STORE_NAMES.UNPAID, { keyPath: 'roomNumber' });
            }
            
            if (!db.objectStoreNames.contains(STORE_NAMES.PAID)) {
                db.createObjectStore(STORE_NAMES.PAID, { keyPath: ['roomNumber', 'currency'] });
            }
            
            if (!db.objectStoreNames.contains(STORE_NAMES.SETTINGS)) {
                db.createObjectStore(STORE_NAMES.SETTINGS, { keyPath: 'key' });
            }
        };
    });
}

const dbOperations = {
    addTransaction: (transaction) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAMES.TRANSACTIONS], 'readwrite');
            const store = tx.objectStore(STORE_NAMES.TRANSACTIONS);
            
            const compressed = LZString.compress(JSON.stringify(transaction));
            const request = store.add({
                ...transaction,
                timestamp: new Date().getTime(),
                compressedData: compressed
            });
            
            request.onsuccess = () => {
                cachedTransactions = null;
                resolve(request.result);
            };
            request.onerror = (event) => reject(event.target.error);
        });
    },
    
    deleteTransaction: (id) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAMES.TRANSACTIONS, STORE_NAMES.PAID, STORE_NAMES.UNPAID], 'readwrite');
            const transactionStore = tx.objectStore(STORE_NAMES.TRANSACTIONS);
            const paidStore = tx.objectStore(STORE_NAMES.PAID);
            const unpaidStore = tx.objectStore(STORE_NAMES.UNPAID);
            
            const getRequest = transactionStore.get(id);
            
            getRequest.onsuccess = () => {
                const transaction = getRequest.result;
                if (!transaction) {
                    reject(new Error('İşlem bulunamadı'));
                    return;
                }
                
                const compressedData = transaction.compressedData;
                const parsedTransaction = compressedData ? JSON.parse(LZString.decompress(compressedData)) : transaction;
                
                const deleteRequest = transactionStore.delete(id);
                
                deleteRequest.onsuccess = async () => {
                    try {
                        if (parsedTransaction.isPaid) {
                            const paidKey = [parsedTransaction.roomNumber, parsedTransaction.currency];
                            const paidGetRequest = paidStore.get(paidKey);
                            paidGetRequest.onsuccess = () => {
                                const paidRecord = paidGetRequest.result;
                                if (paidRecord) {
                                    const newTotal = paidRecord.total - parsedTransaction.amount;
                                    if (newTotal <= 0) {
                                        paidStore.delete(paidKey);
                                    } else {
                                        paidStore.put({ roomNumber: parsedTransaction.roomNumber, currency: parsedTransaction.currency, total: newTotal });
                                    }
                                }
                            };
                            paidGetRequest.onerror = (event) => reject(event.target.error);
                        } else {
                            const unpaidGetRequest = unpaidStore.get(parsedTransaction.roomNumber);
                            unpaidGetRequest.onsuccess = () => {
                                const unpaidRecord = unpaidGetRequest.result;
                                if (unpaidRecord) {
                                    const newCount = unpaidRecord.count - 1;
                                    if (newCount <= 0) {
                                        unpaidStore.delete(parsedTransaction.roomNumber);
                                    } else {
                                        unpaidStore.put({ roomNumber: parsedTransaction.roomNumber, count: newCount });
                                    }
                                }
                            };
                            unpaidGetRequest.onerror = (event) => reject(event.target.error);
                        }
                        cachedTransactions = null;
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                };
                
                deleteRequest.onerror = (event) => reject(event.target.error);
            };
            
            getRequest.onerror = (event) => reject(event.target.error);
        });
    },
    
    getAllTransactions: () => {
        return new Promise((resolve, reject) => {
            if (cachedTransactions) {
                resolve(cachedTransactions);
                return;
            }
            
            const tx = db.transaction([STORE_NAMES.TRANSACTIONS], 'readonly');
            const store = tx.objectStore(STORE_NAMES.TRANSACTIONS);
            const request = store.getAll();
            
            request.onsuccess = () => {
                const transactions = request.result.map(item => {
                    if (item.compressedData) {
                        return JSON.parse(LZString.decompress(item.compressedData));
                    }
                    return item;
                });
                cachedTransactions = transactions;
                resolve(transactions || []);
            };
            request.onerror = (event) => reject(event.target.error);
        });
    },
    
    getFilteredTransactions: (filterFn) => {
        return new Promise((resolve, reject) => {
            if (cachedTransactions) {
                const filtered = cachedTransactions.filter(filterFn);
                resolve(filtered);
                return;
            }
            
            const tx = db.transaction([STORE_NAMES.TRANSACTIONS], 'readonly');
            const store = tx.objectStore(STORE_NAMES.TRANSACTIONS);
            const request = store.getAll();
            
            request.onsuccess = () => {
                const transactions = request.result.map(item => {
                    if (item.compressedData) {
                        return JSON.parse(LZString.decompress(item.compressedData));
                    }
                    return item;
                });
                cachedTransactions = transactions;
                const filtered = transactions.filter(filterFn);
                resolve(filtered);
            };
            request.onerror = (event) => reject(event.target.error);
        });
    },
    
    updateUnpaid: (roomNumber, increment = true) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAMES.UNPAID], 'readwrite');
            const store = tx.objectStore(STORE_NAMES.UNPAID);
            
            const getRequest = store.get(roomNumber);
            
            getRequest.onsuccess = () => {
                let count = 1;
                if (getRequest.result) {
                    count = increment ? getRequest.result.count + 1 : getRequest.result.count - 1;
                }
                
                if (count <= 0) {
                    const deleteRequest = store.delete(roomNumber);
                    deleteRequest.onsuccess = () => resolve(0);
                    deleteRequest.onerror = (event) => reject(event.target.error);
                } else {
                    const putRequest = store.put({ roomNumber, count });
                    putRequest.onsuccess = () => resolve(count);
                    putRequest.onerror = (event) => reject(event.target.error);
                }
            };
            
            getRequest.onerror = (event) => reject(event.target.error);
        });
    },
    
    updatePaid: (roomNumber, currency, amount, increment = true) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAMES.PAID], 'readwrite');
            const store = tx.objectStore(STORE_NAMES.PAID);
            
            const getRequest = store.get([roomNumber, currency]);
            
            getRequest.onsuccess = () => {
                let total = amount;
                if (getRequest.result) {
                    total = increment ? 
                        getRequest.result.total + amount : 
                        getRequest.result.total - amount;
                }
                
                if (total <= 0) {
                    const deleteRequest = store.delete([roomNumber, currency]);
                    deleteRequest.onsuccess = () => resolve(0);
                    deleteRequest.onerror = (event) => reject(event.target.error);
                } else {
                    const putRequest = store.put({ roomNumber, currency, total });
                    putRequest.onsuccess = () => resolve(total);
                    putRequest.onerror = (event) => reject(event.target.error);
                }
            };
            
            getRequest.onerror = (event) => reject(event.target.error);
        });
    },
    
    getAllUnpaid: () => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAMES.UNPAID], 'readonly');
            const store = tx.objectStore(STORE_NAMES.UNPAID);
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event.target.error);
        });
    },
    
    getAllPaid: () => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAMES.PAID], 'readonly');
            const store = tx.objectStore(STORE_NAMES.PAID);
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event.target.error);
        });
    },
    
    saveSetting: (key, value) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAMES.SETTINGS], 'readwrite');
            const store = tx.objectStore(STORE_NAMES.SETTINGS);
            
            const compressed = LZString.compress(JSON.stringify(value));
            const request = store.put({ key, value: compressed });
            
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
        });
    },
    
    getSetting: (key) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAMES.SETTINGS], 'readonly');
            const store = tx.objectStore(STORE_NAMES.SETTINGS);
            
            const request = store.get(key);
            
            request.onsuccess = () => {
                if (request.result && request.result.value) {
                    resolve(JSON.parse(LZString.decompress(request.result.value)));
                } else {
                    resolve(null);
                }
            };
            request.onerror = (event) => reject(event.target.error);
        });
    }
};

function showToast(message, type = 'success') {
    Toastify({
        text: message,
        duration: 3000,
        close: false,
        gravity: "top",
        position: "center",
        backgroundColor: type === 'success' ? '#4CAF50' : type === 'warning' ? '#FF9800' : '#F44336',
        stopOnFocus: false,
        style: {
            width: '90%',
            maxWidth: '300px',
            fontSize: '14px',
            borderRadius: '8px',
            padding: '12px'
        }
    }).showToast();
}

async function fetchExchangeRates() {
    try {
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/TRY');
        if (!response.ok) throw new Error('API isteği başarısız');
        const data = await response.json();
        const rates = {
            USD: 1 / data.rates.USD,
            EUR: 1 / data.rates.EUR,
            GBP: 1 / data.rates.GBP,
            lastUpdated: new Date().toISOString()
        };
        await dbOperations.saveSetting('exchangeRates', rates);
        exchangeRates = rates;
        updateExchangeRateDisplay(rates);
        document.getElementById('manualRates').style.display = 'none';
        showToast('Döviz kurları başarıyla güncellendi!', 'success');
    } catch (error) {
        console.error('Döviz kurları alınırken hata:', error);
        showToast('Döviz kurları alınamadı, manuel giriş kullanılıyor.', 'error');
        document.getElementById('manualRates').style.display = 'block';
    }
}

async function loadExchangeRates() {
    try {
        const cached = await dbOperations.getSetting('exchangeRates');
        if (cached && new Date(cached.lastUpdated) > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
            exchangeRates = cached;
            updateExchangeRateDisplay(cached);
            document.getElementById('manualRates').style.display = 'none';
        } else {
            await fetchExchangeRates();
        }
    } catch (error) {
        console.error('Kur bilgisi yüklenirken hata:', error);
        exchangeRates = {
            USD: 32.45,
            EUR: 35.18,
            GBP: 41.32,
            lastUpdated: new Date().toISOString()
        };
        updateExchangeRateDisplay(exchangeRates);
        document.getElementById('manualRates').style.display = 'block';
        showToast('Kur bilgisi yüklenemedi, varsayılan kurlar kullanılıyor.', 'error');
    }
}

function updateExchangeRateDisplay(rates) {
    document.querySelector('.usd .rate').textContent = rates.USD.toFixed(2);
    document.querySelector('.eur .rate').textContent = rates.EUR.toFixed(2);
    document.querySelector('.gbp .rate').textContent = rates.GBP.toFixed(2);
    
    const lastUpdated = rates.lastUpdated ? new Date(rates.lastUpdated) : new Date();
    const formattedDate = lastUpdated.toLocaleString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    document.getElementById('lastUpdate').textContent = `Son Güncelleme: ${formattedDate}`;
    
    const badges = document.querySelectorAll('.currency-badge');
    badges.forEach(badge => {
        badge.classList.add('updated');
        setTimeout(() => badge.classList.remove('updated'), 1000);
    });
    
    document.getElementById('manualUSD').value = rates.USD.toFixed(2);
    document.getElementById('manualEUR').value = rates.EUR.toFixed(2);
    document.getElementById('manualGBP').value = rates.GBP.toFixed(2);
}

async function saveManualRates() {
    const rates = {
        USD: parseFloat(document.getElementById('manualUSD').value) || 32.45,
        EUR: parseFloat(document.getElementById('manualEUR').value) || 35.18,
        GBP: parseFloat(document.getElementById('manualGBP').value) || 41.32,
        lastUpdated: new Date().toISOString()
    };
    
    if (rates.USD <= 0 || rates.EUR <= 0 || rates.GBP <= 0) {
        showToast('Geçerli pozitif kurlar girin!', 'error');
        return;
    }
    
    await dbOperations.saveSetting('exchangeRates', rates);
    exchangeRates = rates;
    updateExchangeRateDisplay(rates);
    document.getElementById('manualRates').style.display = 'none';
    showToast('Kurlar manuel olarak güncellendi!', 'success');
}

async function calculateStorageStats() {
    try {
        const allRecords = await dbOperations.getAllTransactions();
        const compressedData = LZString.compress(JSON.stringify(allRecords));
        const sizeBytes = compressedData.length * 2;
        const sizeMB = sizeBytes / (1024 * 1024);
        
        const percentUsed = (allRecords.length / STORAGE_LIMITS.MAX_RECORDS) * 100;
        
        if (percentUsed >= 90) {
            showToast('Depolama alanı %90 doldu! Eski kayıtları temizlemeyi düşünün.', 'warning');
        } else if (percentUsed >= 70) {
            showToast('Depolama alanı %70 doldu.', 'warning');
        }
        
        return {
            totalRecords: allRecords.length,
            maxRecords: STORAGE_LIMITS.MAX_RECORDS,
            usedStorageMB: sizeMB.toFixed(2),
            totalStorageMB: STORAGE_LIMITS.MAX_STORAGE_MB,
            remainingRecords: STORAGE_LIMITS.MAX_RECORDS - allRecords.length,
            percentUsed
        };
    } catch (error) {
        console.error('Depolama istatistikleri hesaplanırken hata:', error);
        showToast('Depolama istatistikleri hesaplanırken hata oluştu.', 'error');
        return {
            totalRecords: 0,
            maxRecords: STORAGE_LIMITS.MAX_RECORDS,
            usedStorageMB: 0,
            totalStorageMB: STORAGE_LIMITS.MAX_STORAGE_MB,
            remainingRecords: STORAGE_LIMITS.MAX_RECORDS,
            percentUsed: 0
        };
    }
}

async function showStorageModal() {
    const stats = await calculateStorageStats();
    
    document.getElementById('totalRecords').textContent = stats.totalRecords.toLocaleString();
    document.getElementById('maxRecords').textContent = stats.maxRecords.toLocaleString();
    document.getElementById('remainingRecords').textContent = stats.remainingRecords.toLocaleString();
    document.getElementById('usedStorage').textContent = `${stats.usedStorageMB} MB`;
    document.getElementById('freeStorage').textContent = `${(stats.totalStorageMB - stats.usedStorageMB).toFixed(2)} MB`;
    document.getElementById('progressPercent').textContent = `${stats.percentUsed.toFixed(2)}%`;
    
    const progressBar = document.getElementById('storageProgress');
    progressBar.style.width = `${stats.percentUsed}%`;
    
    document.getElementById('storageModal').style.display = 'block';
}

function convertToTL(amount, currency) {
    if (currency === 'TL') return amount;
    return amount * (exchangeRates[currency] || 1);
}

async function saveTransaction() {
    const roomNumber = document.getElementById('roomNumber').value.trim();
    const date = document.getElementById('date').value;
    const currency = document.getElementById('currency').value;
    const isPaid = document.getElementById('customAmount').checked;
    const amount = isPaid ? parseFloat(document.getElementById('amountInput').value) : 0;
    
    if (!roomNumber || !/^\d+$/.test(roomNumber)) {
        showToast('Geçerli bir oda numarası girin!', 'error');
        return;
    }
    
    if (!date) {
        showToast('Tarih seçin!', 'error');
        return;
    }
    
    const selectedDate = new Date(date);
    if (selectedDate > new Date()) {
        showToast('Gelecek tarihler seçilemez!', 'error');
        return;
    }
    
    if (isPaid && (isNaN(amount) || amount <= 0)) {
        showToast('Geçerli bir tutar girin!', 'error');
        return;
    }
    
    const transaction = {
        roomNumber,
        date,
        currency,
        amount: isPaid ? amount : 0,
        isPaid,
        tlAmount: isPaid ? convertToTL(amount, currency) : 0
    };
    
    try {
        const stats = await calculateStorageStats();
        if (stats.totalRecords >= STORAGE_LIMITS.MAX_RECORDS) {
            showToast('Depolama sınırı aşıldı! Eski kayıtları silin.', 'error');
            return;
        }
        
        await dbOperations.addTransaction(transaction);
        
        if (isPaid) {
            await dbOperations.updatePaid(roomNumber, currency, amount);
        } else {
            await dbOperations.updateUnpaid(roomNumber);
        }
        
        showToast('Kayıt başarıyla eklendi!', 'success');
        document.getElementById('roomNumber').value = '';
        document.getElementById('date').value = new Date().toISOString().split('T')[0];
        document.getElementById('amountInput').value = '';
        document.getElementById('notPaid').checked = true;
        document.getElementById('amountInput').disabled = true;
    } catch (error) {
        console.error('Kayıt eklenirken hata:', error);
        showToast('Kayıt eklenirken hata oluştu.', 'error');
    }
}

async function filterUnpaidTable() {
    const timeRange = document.getElementById('unpaidTimeRange').value;
    const startDate = document.getElementById('unpaidStartDate').value;
    const endDate = document.getElementById('unpaidEndDate').value;
    
    let start, end;
    const now = new Date();
    
    switch (timeRange) {
        case 'today':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
            break;
        case 'yesterday':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
            break;
        case 'lastWeek':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
            end = now;
            break;
        case 'lastMonth':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
            end = now;
            break;
        case 'custom':
            if (!startDate || !endDate) {
                showToast('Başlangıç ve bitiş tarihlerini seçin!', 'error');
                return;
            }
            start = new Date(startDate);
            end = new Date(endDate);
            if (start > end) {
                showToast('Bitiş tarihi başlangıç tarihinden önce olamaz!', 'error');
                return;
            }
            break;
    }
    
    try {
        const unpaid = await dbOperations.getAllUnpaid();
        const transactions = await dbOperations.getFilteredTransactions(t => {
            const tDate = new Date(t.date);
            return !t.isPaid && tDate >= start && tDate <= end;
        });
        
        const unpaidMap = new Map();
        transactions.forEach(t => {
            const existing = unpaidMap.get(t.roomNumber) || { count: 0, lastDate: t.date };
            unpaidMap.set(t.roomNumber, {
                count: existing.count + 1,
                lastDate: t.date > existing.lastDate ? t.date : existing.lastDate
            });
        });
        
        const tableBody = document.querySelector('#unpaidTable tbody');
        tableBody.innerHTML = '';
        
        let totalUnpaid = 0;
        unpaidMap.forEach((data, roomNumber) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${roomNumber}</td>
                <td>${data.count}</td>
                <td>${new Date(data.lastDate).toLocaleDateString('tr-TR')}</td>
            `;
            tableBody.appendChild(row);
            totalUnpaid += data.count;
        });
        
        const totalElement = document.getElementById('unpaidTotal');
        totalElement.textContent = `Toplam Vermeyen: ${totalUnpaid} kayıt`;
        totalElement.classList.add('show-total');
        
        document.getElementById('unpaidModal').style.display = 'block';
    } catch (error) {
        console.error('Vermeyenler filtrelenirken hata:', error);
        showToast('Vermeyenler listesi yüklenemedi.', 'error');
    }
}

async function filterPaidTable() {
    const timeRange = document.getElementById('paidTimeRange').value;
    const currencyFilter = document.getElementById('paidCurrency').value;
    const startDate = document.getElementById('paidStartDate').value;
    const endDate = document.getElementById('paidEndDate').value;
    
    let start, end;
    const now = new Date();
    
    switch (timeRange) {
        case 'today':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
            break;
        case 'yesterday':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
            break;
        case 'lastWeek':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
            end = now;
            break;
        case 'lastMonth':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
            end = now;
            break;
        case 'custom':
            if (!startDate || !endDate) {
                showToast('Başlangıç ve bitiş tarihlerini seçin!', 'error');
                return;
            }
            start = new Date(startDate);
            end = new Date(endDate);
            if (start > end) {
                showToast('Bitiş tarihi başlangıç tarihinden önce olamaz!', 'error');
                return;
            }
            break;
    }
    
    try {
        const transactions = await dbOperations.getFilteredTransactions(t => {
            const tDate = new Date(t.date);
            return t.isPaid && tDate >= start && tDate <= end && (currencyFilter === 'all' || t.currency === currencyFilter);
        });
        
        const paidMap = new Map();
        transactions.forEach(t => {
            const key = `${t.roomNumber}-${t.currency}`;
            const existing = paidMap.get(key) || { total: 0, lastDate: t.date, roomNumber: t.roomNumber, currency: t.currency };
            paidMap.set(key, {
                roomNumber: t.roomNumber,
                currency: t.currency,
                total: existing.total + t.amount,
                lastDate: t.date > existing.lastDate ? t.date : existing.lastDate
            });
        });
        
        const tableBody = document.querySelector('#paidTable tbody');
        tableBody.innerHTML = '';
        
        let totalTL = 0;
        const totals = { TL: 0, USD: 0, EUR: 0, GBP: 0 };
        
        paidMap.forEach(data => {
            const row = document.createElement('tr');
            const tlAmount = convertToTL(data.total, data.currency);
            row.innerHTML = `
                <td>${data.roomNumber}</td>
                <td>${data.currency}</td>
                <td>${data.total.toFixed(2)} ${data.currency} (${tlAmount.toFixed(2)} TL)</td>
                <td>${new Date(data.lastDate).toLocaleDateString('tr-TR')}</td>
            `;
            tableBody.appendChild(row);
            totals[data.currency] += data.total;
            totalTL += tlAmount;
        });
        
        const totalSingle = document.getElementById('paidTotalSingle');
        totalSingle.textContent = `Toplam: ${totalTL.toFixed(2)} TL`;
        totalSingle.classList.add('show-total');
        
        const totalContainer = document.getElementById('paidAllTotals');
        totalContainer.innerHTML = '';
        Object.entries(totals).forEach(([currency, total]) => {
            if (total > 0) {
                const totalDiv = document.createElement('div');
                totalDiv.className = 'total-info';
                totalDiv.textContent = `${currency}: ${total.toFixed(2)}`;
                totalContainer.appendChild(totalDiv);
            }
        });
        totalContainer.classList.add('show-totals');
        
        document.getElementById('paidModal').style.display = 'block';
    } catch (error) {
        console.error('Verenler filtrelenirken hata:', error);
        showToast('Verenler listesi yüklenemedi.', 'error');
    }
}

async function filterTransactionsTable() {
    const timeRange = document.getElementById('transactionsTimeRange').value;
    const currencyFilter = document.getElementById('transactionsCurrency').value;
    const startDate = document.getElementById('transactionsStartDate').value;
    const endDate = document.getElementById('transactionsEndDate').value;
    
    let start, end;
    const now = new Date();
    
    switch (timeRange) {
        case 'today':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
            break;
        case 'yesterday':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
            break;
        case 'lastWeek':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
            end = now;
            break;
        case 'lastMonth':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
            end = now;
            break;
        case 'custom':
            if (!startDate || !endDate) {
                showToast('Başlangıç ve bitiş tarihlerini seçin!', 'error');
                return;
            }
            start = new Date(startDate);
            end = new Date(endDate);
            if (start > end) {
                showToast('Bitiş tarihi başlangıç tarihinden önce olamaz!', 'error');
                return;
            }
            break;
    }
    
    try {
        const transactions = await dbOperations.getFilteredTransactions(t => {
            const tDate = new Date(t.date);
            return tDate >= start && tDate <= end && (currencyFilter === 'all' || t.currency === currencyFilter);
        });
        
        const tableBody = document.querySelector('#lastTransactionsTable tbody');
        tableBody.innerHTML = '';
        
        let totalTL = 0;
        const totals = { TL: 0, USD: 0, EUR: 0, GBP: 0 };
        
        transactions.forEach(t => {
            const row = document.createElement('tr');
            const amountText = t.isPaid ? `${t.amount.toFixed(2)} ${t.currency}` : 'VERMEDİ';
            const tlAmount = t.isPaid ? convertToTL(t.amount, t.currency) : 0;
            row.innerHTML = `
                <td>${new Date(t.date).toLocaleDateString('tr-TR')}</td>
                <td>${t.roomNumber}</td>
                <td>${t.currency}</td>
                <td>${amountText} ${t.isPaid ? `(${tlAmount.toFixed(2)} TL)` : ''}</td>
                <td>
                    <button class="delete-btn" onclick="deleteTransaction(${t.id}, this)" aria-label="Bu işlemi sil">Sil</button>
                </td>
            `;
            tableBody.appendChild(row);
            if (t.isPaid) {
                totals[t.currency] += t.amount;
                totalTL += tlAmount;
            }
        });
        
        const totalSingle = document.getElementById('transactionsTotalSingle');
        totalSingle.textContent = `Toplam: ${totalTL.toFixed(2)} TL`;
        totalSingle.classList.add('show-total');
        
        const totalContainer = document.getElementById('transactionsAllTotals');
        totalContainer.innerHTML = '';
        Object.entries(totals).forEach(([currency, total]) => {
            if (total > 0) {
                const totalDiv = document.createElement('div');
                totalDiv.className = 'total-info';
                totalDiv.textContent = `${currency}: ${total.toFixed(2)}`;
                totalContainer.appendChild(totalDiv);
            }
        });
        totalContainer.classList.add('show-totals');
        
        document.getElementById('lastTransactionsModal').style.display = 'block';
    } catch (error) {
        console.error('İşlemler filtrelenirken hata:', error);
        showToast('İşlem listesi yüklenemedi.', 'error');
    }
}

async function deleteTransaction(id, button) {
    try {
        await dbOperations.deleteTransaction(id);
        button.closest('tr').remove();
        showToast('İşlem başarıyla silindi!', 'success');
        filterTransactionsTable();
    } catch (error) {
        console.error('İşlem silinirken hata:', error);
        showToast('İşlem silinirken hata oluştu.', 'error');
    }
}

function updateUnpaidDateRange() {
    const timeRange = document.getElementById('unpaidTimeRange').value;
    const dateFilter = document.getElementById('unpaidDateFilter');
    dateFilter.style.display = timeRange === 'custom' ? 'flex' : 'none';
}

function updatePaidDateRange() {
    const timeRange = document.getElementById('paidTimeRange').value;
    const dateFilter = document.getElementById('paidDateFilter');
    dateFilter.style.display = timeRange === 'custom' ? 'flex' : 'none';
}

function updateTransactionsDateRange() {
    const timeRange = document.getElementById('transactionsTimeRange').value;
    const dateFilter = document.getElementById('transactionsDateFilter');
    dateFilter.style.display = timeRange === 'custom' ? 'flex' : 'none';
}

function updateAccountingDateRange() {
    const timeRange = document.getElementById('accountingTimeRange').value;
    const dateFilter = document.getElementById('accountingDateFilter');
    dateFilter.style.display = timeRange === 'custom' ? 'flex' : 'none';
}

async function updateReportChart() {
    try {
        const transactions = await dbOperations.getFilteredTransactions(t => t.isPaid);
        const currency = selectedCurrencies[0];
        const chartType = document.getElementById('chartType').value;
        
        const dataByDay = {};
        transactions.forEach(t => {
            if (t.currency === currency || currency === 'TL') {
                const date = new Date(t.date);
                const monthKey = `${date.getFullYear()}-${date.getMonth() + 1}`;
                if (monthKey === `${currentDate.getFullYear()}-${currentDate.getMonth() + 1}`) {
                    const dayKey = date.getDate();
                    dataByDay[dayKey] = (dataByDay[dayKey] || 0) + (currency === 'TL' ? t.tlAmount : t.amount);
                }
            }
        });
        
        const labels = Array.from({ length: new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate() }, (_, i) => i + 1);
        const data = labels.map(day => dataByDay[day] || 0);
        
        const ctx = document.getElementById('reportChart').getContext('2d');
        if (currentChart) {
            currentChart.destroy();
        }
        
        const chartConfig = {
            type: chartType === 'area' ? 'line' : chartType,
            data: {
                labels,
                datasets: [{
                    label: `Günlük Gelir (${currency})`,
                    data,
                    borderColor: currency === 'TL' ? '#4CAF50' : currency === 'USD' ? '#2196F3' : currency === 'EUR' ? '#9C27B0' : '#FF9800',
                    backgroundColor: currency === 'TL' ? 'rgba(76, 175, 80, 0.2)' : currency === 'USD' ? 'rgba(33, 150, 243, 0.2)' : currency === 'EUR' ? 'rgba(156, 39, 176, 0.2)' : 'rgba(255, 152, 0, 0.2)',
                    fill: chartType === 'area',
                    tension: chartType === 'line' || chartType === 'area' ? 0.4 : 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: `Tutar (${currency})`
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Gün'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: true
                    }
                }
            }
        };
        
        currentChart = new Chart(ctx, chartConfig);
        
        document.getElementById('currentMonth').textContent = currentDate.toLocaleString('tr-TR', { month: 'long', year: 'numeric' });
    } catch (error) {
        console.error('Rapor grafiği oluşturulurken hata:', error);
        showToast('Rapor grafiği yüklenemedi.', 'error');
    }
}

function toggleCurrency(currency) {
    selectedCurrencies = [currency];
    document.querySelectorAll('.currency-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.currency === currency);
    });
    updateReportChart();
}

function changeMonth(delta) {
    currentDate.setMonth(currentDate.getMonth() + delta);
    updateReportChart();
}

async function showStatsModal() {
    try {
        const transactions = await dbOperations.getAllTransactions();
        const unpaid = await dbOperations.getAllUnpaid();
        const paid = await dbOperations.getAllPaid();
        
        const uniqueRooms = new Set(transactions.map(t => t.roomNumber));
        const totalRooms = uniqueRooms.size;
        const totalTransactions = transactions.length;
        const paidTransactions = transactions.filter(t => t.isPaid).length;
        const avgPaymentRate = totalTransactions > 0 ? (paidTransactions / totalTransactions * 100).toFixed(2) : 0;
        
        let maxTlPayment = 0;
        let maxTlRoom = '-';
        const paidMap = new Map();
        paid.forEach(p => {
            const tlAmount = convertToTL(p.total, p.currency);
            if (tlAmount > maxTlPayment) {
                maxTlPayment = tlAmount;
                maxTlRoom = p.roomNumber;
            }
            paidMap.set(`${p.roomNumber}-${p.currency}`, { ...p, tlAmount });
        });
        
        document.getElementById('totalRooms').textContent = totalRooms.toLocaleString();
        document.getElementById('avgPaymentRate').textContent = `${avgPaymentRate}%`;
        document.getElementById('totalTransactions').textContent = totalTransactions.toLocaleString();
        document.getElementById('maxTlPayment').textContent = `${maxTlPayment.toFixed(2)} TL`;
        document.getElementById('maxTlRoom').textContent = `Oda: ${maxTlRoom}`;
        
        const topPayers = Array.from(paidMap.values())
            .sort((a, b) => b.tlAmount - a.tlAmount)
            .slice(0, 5);
        const topNonPayers = unpaid
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);
        
        const topPayersList = document.getElementById('topPayers');
        topPayersList.innerHTML = '';
        topPayers.forEach(p => {
            const li = document.createElement('div');
            li.className = 'top-item positive';
            li.innerHTML = `
                <span class="room-number">${p.roomNumber}</span>
                <div class="room-stats">
                    <span class="stat-value">${p.total.toFixed(2)} ${p.currency}</span>
                    <span class="stat-percentage">(${p.tlAmount.toFixed(2)} TL)</span>
                </div>
            `;
            topPayersList.appendChild(li);
        });
        
        const topNonPayersList = document.getElementById('topNonPayers');
        topNonPayersList.innerHTML = '';
        topNonPayers.forEach(u => {
            const li = document.createElement('div');
            li.className = 'top-item negative';
            li.innerHTML = `
                <span class="room-number">${u.roomNumber}</span>
                <div class="room-stats">
                    <span class="stat-value">${u.count} kez</span>
                </div>
            `;
            topNonPayersList.appendChild(li);
        });
        
        const paymentRatioData = {
            labels: ['Ödeme Yapan', 'Ödeme Yapmayan'],
            datasets: [{
                data: [paidTransactions, totalTransactions - paidTransactions],
                backgroundColor: ['#4CAF50', '#F44336']
            }]
        };
        
        const currencyRatioData = {
            labels: ['TL', 'USD', 'EUR', 'GBP'],
            datasets: [{
                data: [
                    paid.filter(p => p.currency === 'TL').reduce((sum, p) => sum + p.total, 0),
                    paid.filter(p => p.currency === 'USD').reduce((sum, p) => sum + p.total, 0),
                    paid.filter(p => p.currency === 'EUR').reduce((sum, p) => sum + p.total, 0),
                    paid.filter(p => p.currency === 'GBP').reduce((sum, p) => sum + p.total, 0)
                ],
                backgroundColor: ['#4CAF50', '#2196F3', '#9C27B0', '#FF9800']
            }]
        };
        
        const comparisonData = {
            labels: Array.from({ length: 12 }, (_, i) => new Date(currentDate.getFullYear(), i, 1).toLocaleString('tr-TR', { month: 'short' })),
            datasets: [
                {
                    label: 'Ödeme Yapan',
                    data: Array.from({ length: 12 }, (_, i) => {
                        const monthTransactions = transactions.filter(t => new Date(t.date).getMonth() === i && t.isPaid);
                        return monthTransactions.length;
                    }),
                    backgroundColor: '#4CAF50'
                },
                {
                    label: 'Ödeme Yapmayan',
                    data: Array.from({ length: 12 }, (_, i) => {
                        const monthTransactions = transactions.filter(t => new Date(t.date).getMonth() === i && !t.isPaid);
                        return monthTransactions.length;
                    }),
                    backgroundColor: '#F44336'
                }
            ]
        };
        
        const ctxPayment = document.getElementById('paymentRatioChart').getContext('2d');
        if (paymentRatioChart) {
            paymentRatioChart.destroy();
        }
        paymentRatioChart = new Chart(ctxPayment, {
            type: 'pie',
            data: paymentRatioData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
        
        const ctxCurrency = document.getElementById('currencyRatioChart').getContext('2d');
        if (currencyRatioChart) {
            currencyRatioChart.destroy();
        }
        currencyRatioChart = new Chart(ctxCurrency, {
            type: 'doughnut',
            data: currencyRatioData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
        
        const ctxComparison = document.getElementById('comparisonChart').getContext('2d');
        if (comparisonChart) {
            comparisonChart.destroy();
        }
        comparisonChart = new Chart(ctxComparison, {
            type: 'bar',
            data: comparisonData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'İşlem Sayısı'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Ay'
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'top'
                    }
                }
            }
        });
        
        document.getElementById('statsModal').style.display = 'block';
    } catch (error) {
        console.error('İstatistikler yüklenirken hata:', error);
        showToast('İstatistikler yüklenemedi.', 'error');
    }
}

async function showAccountingSummary() {
    const timeRange = document.getElementById('accountingTimeRange').value;
    const startDate = document.getElementById('accountingStartDate').value;
    const endDate = document.getElementById('accountingEndDate').value;
    
    let start, end;
    const now = new Date();
    
    switch (timeRange) {
        case 'today':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
            break;
        case 'yesterday':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
            break;
        case 'lastWeek':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
            end = now;
            break;
        case 'lastMonth':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
            end = now;
            break;
        case 'custom':
            if (!startDate || !endDate) {
                showToast('Başlangıç ve bitiş tarihlerini seçin!', 'error');
                return;
            }
            start = new Date(startDate);
            end = new Date(endDate);
            if (start > end) {
                showToast('Bitiş tarihi başlangıç tarihinden önce olamaz!', 'error');
                return;
            }
            break;
    }
    
    try {
        const transactions = await dbOperations.getFilteredTransactions(t => {
            const tDate = new Date(t.date);
            return t.isPaid && tDate >= start && tDate <= end;
        });
        
        const totals = {
            TL: 0,
            USD: 0,
            EUR: 0,
            GBP: 0,
            totalTL: 0
        };
        
        transactions.forEach(t => {
            totals[t.currency] += t.amount;
            totals.totalTL += convertToTL(t.amount, t.currency);
        });
        
        const summaryDiv = document.getElementById('accountingSummary');
        summaryDiv.innerHTML = `
            <h3>Kazanç Özeti</h3>
            <p>TL: ${totals.TL.toFixed(2)} TL</p>
            <p>USD: ${totals.USD.toFixed(2)} USD (${convertToTL(totals.USD, 'USD').toFixed(2)} TL)</p>
            <p>EUR: ${totals.EUR.toFixed(2)} EUR (${convertToTL(totals.EUR, 'EUR').toFixed(2)} TL)</p>
            <p>GBP: ${totals.GBP.toFixed(2)} GBP (${convertToTL(totals.GBP, 'GBP').toFixed(2)} TL)</p>
            <p class="total">Toplam: ${totals.totalTL.toFixed(2)} TL</p>
        `;
        
        const pieData = {
            labels: ['TL', 'USD', 'EUR', 'GBP'],
            datasets: [{
                data: [
                    convertToTL(totals.TL, 'TL'),
                    convertToTL(totals.USD, 'USD'),
                    convertToTL(totals.EUR, 'EUR'),
                    convertToTL(totals.GBP, 'GBP')
                ],
                backgroundColor: ['#4CAF50', '#2196F3', '#9C27B0', '#FF9800']
            }]
        };
        
        const ctxPie = document.getElementById('accountingPieChart').getContext('2d');
        if (accountingPieChart) {
            accountingPieChart.destroy();
        }
        accountingPieChart = new Chart(ctxPie, {
            type: 'pie',
            data: pieData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom'
                    },
                    title: {
                        display: true,
                        text: 'Döviz Dağılımı (TL Bazında)'
                    }
                }
            }
        });
        
        document.getElementById('accountingModal').style.display = 'block';
    } catch (error) {
        console.error('Muhasebe özeti yüklenirken hata:', error);
        showToast('Muhasebe özeti yüklenemedi.', 'error');
    }
}

async function generatePDFReport() {
    try {
        const transactions = await dbOperations.getAllTransactions();
        const unpaid = await dbOperations.getAllUnpaid();
        const paid = await dbOperations.getAllPaid();
        const stats = await calculateStorageStats();
        
        const totals = {
            TL: 0,
            USD: 0,
            EUR: 0,
            GBP: 0,
            totalTL: 0
        };
        
        paid.forEach(p => {
            totals[p.currency] += p.total;
            totals.totalTL += convertToTL(p.total, p.currency);
        });
        
        const topPayers = paid
            .map(p => ({ ...p, tlAmount: convertToTL(p.total, p.currency) }))
            .sort((a, b) => b.tlAmount - a.tlAmount)
            .slice(0, 5);
        
        const topNonPayers = unpaid
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);
        
        const uniqueRooms = new Set(transactions.map(t => t.roomNumber)).size;
        const totalTransactions = transactions.length;
        const paidTransactions = transactions.filter(t => t.isPaid).length;
        const avgPaymentRate = totalTransactions > 0 ? (paidTransactions / totalTransactions * 100).toFixed(2) : 0;
        
        const latexContent = `
\\documentclass[a4paper,12pt]{article}
\\usepackage{geometry}
\\geometry{a4paper, margin=1in}
\\usepackage{utf8x}
\\usepackage{ucs}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{array}
\\usepackage{booktabs}
\\usepackage{colortbl}
\\usepackage{xcolor}
\\usepackage{noto}
\\definecolor{primary}{RGB}{76,175,80}
\\definecolor{error}{RGB}{244,67,54}
\\begin{document}

\\begin{center}
    \\LARGE \\textbf{Oda Gelir Takip Raporu} \\\\
    \\normalsize Tarih: ${new Date().toLocaleString('tr-TR')}
\\end{center}

\\section*{Genel İstatistikler}
\\begin{tabular}{ll}
    \\textbf{Toplam Oda Sayısı:} & ${uniqueRooms.toLocaleString()} \\\\
    \\textbf{Toplam İşlem Sayısı:} & ${totalTransactions.toLocaleString()} \\\\
    \\textbf{Ödeme Oranı:} & ${avgPaymentRate}\\% \\\\
    \\textbf{Toplam Kazanç (TL):} & ${totals.totalTL.toFixed(2)} TL
\\end{tabular}

\\section*{Kazanç Özeti}
\\begin{tabular}{lr}
    \\toprule
    \\textbf{Döviz} & \\textbf{Tutar} \\\\
    \\midrule
    TL & ${totals.TL.toFixed(2)} TL \\\\
    USD & ${totals.USD.toFixed(2)} USD (${convertToTL(totals.USD, 'USD').toFixed(2)} TL) \\\\
    EUR & ${totals.EUR.toFixed(2)} EUR (${convertToTL(totals.EUR, 'EUR').toFixed(2)} TL) \\\\
    GBP & ${totals.GBP.toFixed(2)} GBP (${convertToTL(totals.GBP, 'GBP').toFixed(2)} TL) \\\\
    \\midrule
    \\textbf{Toplam (TL):} & ${totals.totalTL.toFixed(2)} TL \\\\
    \\bottomrule
\\end{tabular}

\\section*{En Çok Ödeme Yapanlar}
\\begin{tabular}{llr}
    \\toprule
    \\textbf{Oda No} & \\textbf{Döviz} & \\textbf{Tutar} \\\\
    \\midrule
    ${topPayers.map(p => `${p.roomNumber} & ${p.currency} & ${p.total.toFixed(2)} ${p.currency} (${p.tlAmount.toFixed(2)} TL)`).join(' \\\\ ')}
    \\bottomrule
\\end{tabular}

\\section*{En Çok Ödeme Atlayanlar}
\\begin{tabular}{lr}
    \\toprule
    \\textbf{Oda No} & \\textbf{Vermeme Sayısı} \\\\
    \\midrule
    ${topNonPayers.map(u => `${u.roomNumber} & ${u.count}`).join(' \\\\ ')}
    \\bottomrule
\\end{tabular}

\\section*{Depolama Durumu}
\\begin{tabular}{ll}
    \\textbf{Toplam Kayıt:} & ${stats.totalRecords.toLocaleString()} / ${stats.maxRecords.toLocaleString()} \\\\
    \\textbf{Kullanılan Alan:} & ${stats.usedStorageMB} MB / ${stats.totalStorageMB} MB \\\\
    \\textbf{Kalan Kayıt:} & ${stats.remainingRecords.toLocaleString()} \\\\
    \\textbf{Kullanım Oranı:} & ${stats.percentUsed.toFixed(2)}\\%
\\end{tabular}

\\end{document}
        `;
        
        const blob = new Blob([latexContent], { type: 'text/latex' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Oda_Gelir_Raporu_${new Date().toISOString().split('T')[0]}.tex`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast('Rapor başarıyla oluşturuldu!', 'success');
    } catch (error) {
        console.error('PDF raporu oluşturulurken hata:', error);
        showToast('Rapor oluşturulurken hata oluştu.', 'error');
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

function setMaxDate() {
    const today = new Date().toISOString().split('T')[0];
    document.querySelectorAll('input[type="date"]').forEach(input => {
        input.max = today;
        if (input.id === 'date') {
            input.value = today;
        }
    });
}

async function initializeApp() {
    try {
        await openDatabase();
        await loadExchangeRates();
        setMaxDate();
        
        document.getElementById('saveButton').addEventListener('click', saveTransaction);
        document.getElementById('refreshRatesButton').addEventListener('click', fetchExchangeRates);
        document.getElementById('menuButton').addEventListener('click', () => {
            const menu = document.getElementById('menu');
            menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
        });
        
        document.getElementById('unpaidMenu').addEventListener('click', filterUnpaidTable);
        document.getElementById('paidMenu').addEventListener('click', filterPaidTable);
        document.getElementById('lastTransactionsMenu').addEventListener('click', filterTransactionsTable);
        document.getElementById('reportMenu').addEventListener('click', () => {
            document.getElementById('reportModal').style.display = 'block';
            updateReportChart();
        });
        document.getElementById('statsMenu').addEventListener('click', showStatsModal);
        document.getElementById('accountingMenu').addEventListener('click', () => {
            document.getElementById('accountingModal').style.display = 'block';
            showAccountingSummary();
        });
        document.getElementById('storageMenu').addEventListener('click', showStorageModal);
        
        document.getElementById('themeToggle').addEventListener('change', (e) => {
            document.body.classList.toggle('dark-theme', e.target.checked);
            dbOperations.saveSetting('theme', e.target.checked ? 'dark' : 'light');
        });
        
        const customAmount = document.getElementById('customAmount');
        const notPaid = document.getElementById('notPaid');
        const amountInput = document.getElementById('amountInput');
        
        customAmount.addEventListener('input', () => {
            amountInput.disabled = false;
            notPaid.checked = false;
        });
        
        notPaid.addEventListener('input', () => {
            amountInput.disabled = true;
            customAmount.checked = false;
            amountInput.value = '';
        });
        
        const savedTheme = await dbOperations.getSetting('theme');
        if (savedTheme === 'dark') {
            document.getElementById('themeToggle').checked = true;
            document.body.classList.add('dark-theme');
        }
        
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('menu');
            const menuButton = document.getElementById('menuButton');
            if (!menu.contains(e.target) && !menuButton.contains(e.target)) {
                menu.style.display = 'none';
            }
        });
        
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.style.display = 'none';
                }
            });
        });
        
        document.getElementById('roomNumber').addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
        });
    } catch (error) {
        console.error('Uygulama başlatılırken hata:', error);
        showToast('Uygulama başlatılamadı.', 'error');
    }
}

document.addEventListener('DOMContentLoaded', initializeApp);
