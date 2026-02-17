from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy import Column, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

app = FastAPI()
engine = create_engine("sqlite:///./products.db", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

class Product(Base):
    __tablename__ = "products"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    price = Column(Integer, nullable=False)

class ProductIn(BaseModel):
    name: str
    price: int

Base.metadata.create_all(bind=engine)

@app.get("/products")
def list_products():
    db = SessionLocal()
    try:
        return [{"id": p.id, "name": p.name, "price": p.price} for p in db.query(Product).all()]
    finally:
        db.close()

@app.post("/products")
def create_product(body: ProductIn):
    db = SessionLocal()
    try:
        item = Product(name=body.name, price=body.price)
        db.add(item)
        db.commit()
        db.refresh(item)
        return {"id": item.id, "name": item.name, "price": item.price}
    finally:
        db.close()

@app.put("/products/{product_id}")
def update_product(product_id: int, body: ProductIn):
    db = SessionLocal()
    try:
        item = db.query(Product).filter(Product.id == product_id).first()
        if not item:
            raise HTTPException(status_code=404, detail="Product not found")
        item.name = body.name
        item.price = body.price
        db.commit()
        return {"id": item.id, "name": item.name, "price": item.price}
    finally:
        db.close()

@app.delete("/products/{product_id}")
def delete_product(product_id: int):
    db = SessionLocal()
    try:
        item = db.query(Product).filter(Product.id == product_id).first()
        if not item:
            raise HTTPException(status_code=404, detail="Product not found")
        db.delete(item)
        db.commit()
        return {"ok": True}
    finally:
        db.close()
